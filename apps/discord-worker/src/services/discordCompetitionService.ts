import {
  discordApiRequest,
  retryDiscordRateLimitedOperation,
} from '../discord/api';
import type { Env } from '../discord/types';
import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import { getRequiredEnv } from '../utils/env';
import type {
  CompetitionArchiveInternalEvent,
  CompetitionSyncInternalEvent,
  CompetitionSyncResult,
} from '../internal-events/types';
import { DiscordApiError } from '../utils/errors';
import type { DiscordEmbed } from '@pccbot/shared';

type CompetitionProjection = CompetitionSyncInternalEvent['competition'];
type CompetitionEntry = CompetitionProjection['entries'][number];
type RankableCompetitionEntry = CompetitionEntry & {
  discordUserId: string;
  title: string;
};

interface DiscordPermissionOverwrite {
  allow: string;
  deny: string;
  id: string;
  type: number;
}

interface DiscordChannel {
  guild_id?: string;
  id: string;
  message?: { id?: string };
  name?: string;
  parent_id?: string | null;
  permission_overwrites?: DiscordPermissionOverwrite[];
  thread_metadata?: { archived?: boolean; locked?: boolean };
  topic?: string | null;
  type?: number;
}

interface DiscordMessage {
  reactions?: Array<{
    emoji?: { id?: string | null; name?: string | null };
  }>;
}

interface DiscordReactionUser {
  bot?: boolean;
  id?: string;
}

interface DiscordThreadList {
  threads?: DiscordChannel[];
}

const FORUM_CHANNEL_TYPE = 15;
const ADD_REACTIONS_PERMISSION = 64n;
const SEND_MESSAGES_PERMISSION = 2_048n;
const CREATE_PUBLIC_THREADS_PERMISSION = 34_359_738_368n;
const CREATE_PRIVATE_THREADS_PERMISSION = 68_719_476_736n;
const SEND_MESSAGES_IN_THREADS_PERMISSION = 274_877_906_944n;
const WRITE_AND_REACTION_PERMISSIONS =
  ADD_REACTIONS_PERMISSION |
  SEND_MESSAGES_PERMISSION |
  CREATE_PUBLIC_THREADS_PERMISSION |
  CREATE_PRIVATE_THREADS_PERMISSION |
  SEND_MESSAGES_IN_THREADS_PERMISSION;
export const COMPETITION_VOTE_EMOJI = '❤️';
const PLACEMENT_EMOJI: Record<number, string> = {
  1: '1️⃣',
  2: '2️⃣',
  3: '3️⃣',
};

export async function deleteDiscordCompetition(
  env: Env,
  forumChannelId: string,
) {
  try {
    await competitionDiscordRequest(env, `/channels/${forumChannelId}`, {
      method: 'DELETE',
    });
  } catch (error) {
    if (!(error instanceof DiscordApiError) || error.status !== 404)
      throw error;
  }
}

export async function syncDiscordCompetition(
  env: Env,
  event: CompetitionSyncInternalEvent,
) {
  const projection = event.competition;
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const botUserId = getRequiredEnv(env, 'DISCORD_APPLICATION_ID');
  const baseMarker = `pcc-competition:${projection.id}`;
  const revisionMarker = `${baseMarker};revision:${projection.syncRevision}`;
  let forum = await findCompetitionForum(env, guildId, projection, baseMarker);
  const activePermissionOverwrites =
    projection.status === 'closed'
      ? undefined
      : await getActiveCompetitionPermissionOverwrites(
          env,
          guildId,
          botUserId,
          projection.status,
        );

  if (!forum) {
    forum = await competitionDiscordRequest<DiscordChannel>(
      env,
      `/guilds/${guildId}/channels`,
      {
        body: JSON.stringify({
          name: normalizeCompetitionForumName(projection.title),
          parent_id: DISCORD_CHANNEL_IDS.competitionActiveCategory,
          permission_overwrites: activePermissionOverwrites,
          topic: revisionMarker,
          type: FORUM_CHANNEL_TYPE,
        }),
        method: 'POST',
      },
    );
  }
  const existingRevision = readMarkerRevision(forum.topic);
  if (existingRevision > projection.syncRevision) {
    throw new Error('Stale competition sync ignored.');
  }
  const forumPermissionOverwrites =
    projection.status === 'closed'
      ? buildReadOnlyOverwrites(
          forum.permission_overwrites?.length
            ? forum.permission_overwrites
            : [{ allow: '0', deny: '0', id: guildId, type: 0 }],
          guildId,
          botUserId,
        )
      : activePermissionOverwrites;
  let completedProjection = projection;
  let marker = revisionMarker;
  let persistedResults: CompetitionSyncResult[] | null = null;
  let winnerMarkerSecret: string | null = null;
  if (projection.status === 'closed' && projection.results.length === 0) {
    winnerMarkerSecret = getRequiredEnv(env, 'WORKER_SECRET');
    persistedResults = await readPersistedCompetitionResults(
      forum.topic,
      projection.entries,
      projection.id,
      projection.syncRevision,
      winnerMarkerSecret,
    );
    if (persistedResults) marker = forum.topic ?? revisionMarker;
  }

  // Closing freezes voting before the first reaction is counted. If ranking
  // later fails, the vote reactions remain intact and a retry can recount them.
  let competitionForum = await updateCompetitionForum(
    env,
    forum,
    projection,
    marker,
    forumPermissionOverwrites,
  );

  if (projection.status === 'closed' && projection.results.length === 0) {
    const results =
      persistedResults ??
      (await rankCompetitionEntriesFromDiscord(env, projection, botUserId));
    completedProjection = { ...projection, results };
    const signedMarker = await createCompetitionWinnerMarker(
      baseMarker,
      projection.syncRevision,
      results,
      winnerMarkerSecret!,
    );
    if (signedMarker !== marker) {
      competitionForum = await updateCompetitionForum(
        env,
        competitionForum,
        completedProjection,
        signedMarker,
        forumPermissionOverwrites,
      );
    }
  }
  const status = await upsertCompetitionStatusPost(
    env,
    guildId,
    competitionForum.id,
    completedProjection,
  );

  if (completedProjection.status !== 'draft') {
    await reconcileCompetitionEntryReactions(
      env,
      competitionForum.id,
      completedProjection,
    );
  }

  return {
    forumChannelId: competitionForum.id,
    statusMessageId: status.messageId,
    statusThreadId: status.threadId,
  };
}

export async function createCompetitionWinnerMarker(
  baseMarker: string,
  syncRevision: number,
  results: CompetitionSyncResult[],
  secret: string,
) {
  const winnerIds = results.map((result) => result.threadId).join(',');
  const unsignedMarker = `${baseMarker};winners:${winnerIds || 'none'};revision:${syncRevision}`;
  const signature = await signCompetitionWinnerMarker(unsignedMarker, secret);
  return `${baseMarker};winners:${winnerIds || 'none'};signature:${signature};revision:${syncRevision}`;
}

export async function readPersistedCompetitionResults(
  topic: string | null | undefined,
  entries: CompetitionEntry[],
  competitionId: string,
  syncRevision: number,
  secret: string,
): Promise<CompetitionSyncResult[] | null> {
  const winnerMatch =
    /^pcc-competition:([0-9a-f-]+);winners:([^;]+);signature:([a-f0-9]{64});revision:(\d+)$/.exec(
      topic ?? '',
    );
  if (!winnerMatch) return null;
  const [, markerCompetitionId, winnerList, signature, markerRevision] =
    winnerMatch;
  if (
    markerCompetitionId !== competitionId ||
    Number(markerRevision) !== syncRevision
  ) {
    return null;
  }
  const unsignedMarker = `pcc-competition:${competitionId};winners:${winnerList};revision:${syncRevision}`;
  if (
    !(await verifyCompetitionWinnerMarker(
      unsignedMarker,
      signature ?? '',
      secret,
    ))
  ) {
    return null;
  }
  if (winnerList === 'none') return [];

  const winnerIds = winnerList?.split(',') ?? [];
  if (
    winnerIds.length === 0 ||
    winnerIds.length > 3 ||
    new Set(winnerIds).size !== winnerIds.length
  ) {
    return null;
  }

  const entriesByThread = new Map(
    entries.map((entry) => [entry.threadId, entry]),
  );
  const results: CompetitionSyncResult[] = [];
  for (const [index, threadId] of winnerIds.entries()) {
    const entry = entriesByThread.get(threadId);
    if (!entry?.discordUserId || !entry.title) return null;
    results.push({
      description: entry.description ?? '',
      discordUserId: entry.discordUserId,
      messageId: entry.messageId,
      place: (index + 1) as 1 | 2 | 3,
      threadId: entry.threadId,
      title: entry.title,
    });
  }
  return results;
}

async function rankCompetitionEntriesFromDiscord(
  env: Env,
  projection: CompetitionProjection,
  botUserId: string,
) {
  const entriesWithVotes = [];
  for (const [index, entry] of projection.entries.entries()) {
    const { discordUserId, title } = entry;
    if (!discordUserId || !title) continue;
    const votes = await countEligibleCompetitionVotes(env, entry, botUserId);
    if (votes === 0) continue;
    entriesWithVotes.push({
      entry: { ...entry, discordUserId, title },
      index,
      votes,
    });
  }

  return rankCompetitionEntriesByVotes(entriesWithVotes);
}

async function countEligibleCompetitionVotes(
  env: Env,
  entry: CompetitionEntry,
  botUserId: string,
) {
  const pageSize = 100;
  const maxPages = 100;
  let after: string | null = null;
  let users: DiscordReactionUser[] = [];

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const query = new URLSearchParams({ limit: String(pageSize), type: '0' });
    if (after) query.set('after', after);
    const page = await tryCompetitionDiscordRequest<DiscordReactionUser[]>(
      env,
      `/channels/${entry.threadId}/messages/${entry.messageId}/reactions/${encodeURIComponent(COMPETITION_VOTE_EMOJI)}?${query}`,
    );
    if (!page) return 0;
    users = [...users, ...page];
    if (page.length < pageSize) break;
    const lastUserId = page.at(-1)?.id;
    if (!lastUserId || lastUserId === after) break;
    after = lastUserId;
    if (pageNumber === maxPages - 1) {
      throw new Error('Competition vote count exceeds the supported limit.');
    }
  }

  return new Set(
    users
      .filter((user) => user.bot !== true && user.id && user.id !== botUserId)
      .map((user) => user.id),
  ).size;
}

async function signCompetitionWinnerMarker(marker: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(marker),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyCompetitionWinnerMarker(
  marker: string,
  signature: string,
  secret: string,
) {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['verify'],
  );
  const signatureBytes = Uint8Array.from(
    signature.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    new TextEncoder().encode(marker),
  );
}

export function rankCompetitionEntriesByVotes(
  entriesWithVotes: Array<{
    entry: RankableCompetitionEntry;
    index: number;
    votes: number;
  }>,
): CompetitionSyncResult[] {
  return entriesWithVotes
    .filter(({ votes }) => Number.isSafeInteger(votes) && votes > 0)
    .slice()
    .sort(
      (first, second) =>
        second.votes - first.votes || first.index - second.index,
    )
    .slice(0, 3)
    .map(({ entry }, index) => ({
      description: entry.description ?? '',
      discordUserId: entry.discordUserId,
      messageId: entry.messageId,
      place: (index + 1) as 1 | 2 | 3,
      threadId: entry.threadId,
      title: entry.title,
    }));
}

export function buildCompetitionStatusMessage(
  projection: CompetitionProjection,
  guildId: string,
) {
  const presentation = {
    closed: {
      color: 0x737373,
      description: 'This competition has ended.',
      status: '🏁 Ended',
    },
    draft: {
      color: 0x737373,
      description: 'This competition is being prepared.',
      status: '🛠️ Draft',
    },
    judging: {
      color: 0xf2c94c,
      description: `Voting is open. React with ${COMPETITION_VOTE_EMOJI} on an entry post to vote.`,
      status: '🗳️ Voting open',
    },
    open: {
      color: 0x57d68d,
      description: 'Entries are open. Create one post in this forum to enter.',
      status: '🟢 Open for entries',
    },
  }[projection.status];
  const deadline = projection.submissionDeadline
    ? formatDiscordDeadline(projection.submissionDeadline)
    : 'Not set';
  const fields: NonNullable<DiscordEmbed['fields']> = [
    { inline: true, name: 'Status', value: presentation.status },
    { inline: true, name: 'Entry deadline', value: deadline },
    ...(projection.theme
      ? [
          {
            inline: true,
            name: 'Theme',
            value: escapeDiscordText(projection.theme),
          },
        ]
      : []),
  ];

  if (projection.status === 'open') {
    fields.push({
      name: 'How to enter',
      value: [
        '• One entry per person.',
        '• Use the photo title as the post title.',
        '• Write one short line about the image.',
        '• Attach exactly one image.',
      ].join('\n'),
    });
  }
  if (projection.status === 'judging') {
    fields.push({
      name: 'How to vote',
      value: `React with ${COMPETITION_VOTE_EMOJI} on any entry post you want to support.`,
    });
  }
  if (projection.status === 'closed') {
    fields.push({
      name: 'Results',
      value: formatCompetitionResults(projection, guildId),
    });
  }

  const embed: DiscordEmbed = {
    color: presentation.color,
    description: [
      presentation.description,
      projection.description
        ? `> ${escapeDiscordText(projection.description)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    fields,
    footer: { text: 'Purdue Photography Club · Photo competition' },
    title: `📷 ${escapeDiscordText(projection.title)}`,
  };

  return {
    allowed_mentions: { parse: [] as string[] },
    content: '',
    embeds: [embed],
  };
}

function formatCompetitionResults(
  projection: CompetitionProjection,
  guildId: string,
) {
  if (projection.results.length === 0) {
    return 'No results were published for this competition.';
  }

  return [...projection.results]
    .sort((a, b) => a.place - b.place)
    .map(
      (result) =>
        `${PLACEMENT_EMOJI[result.place] ?? `${result.place}.`} <@${result.discordUserId}> · [${escapeDiscordText(result.title)}](https://discord.com/channels/${guildId}/${result.threadId}/${result.messageId})`,
    )
    .join('\n');
}

export function normalizeCompetitionForumName(title: string) {
  return (
    title
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'photo-competition'
  );
}

export function buildReadOnlyOverwrites(
  overwrites: DiscordPermissionOverwrite[],
  guildId: string,
  botUserId?: string,
): DiscordPermissionOverwrite[] {
  return buildCompetitionPermissionOverwrites(
    overwrites,
    guildId,
    botUserId,
    0n,
    WRITE_AND_REACTION_PERMISSIONS,
  );
}

export function buildActiveCompetitionForumOverwrites(
  overwrites: DiscordPermissionOverwrite[],
  guildId: string,
  status: 'draft' | 'judging' | 'open',
  botUserId?: string,
): DiscordPermissionOverwrite[] {
  const memberAllow =
    status === 'open'
      ? SEND_MESSAGES_PERMISSION
      : status === 'judging'
        ? ADD_REACTIONS_PERMISSION
        : 0n;
  return buildCompetitionPermissionOverwrites(
    overwrites,
    guildId,
    botUserId,
    memberAllow,
    WRITE_AND_REACTION_PERMISSIONS & ~memberAllow,
  );
}

function buildCompetitionPermissionOverwrites(
  overwrites: DiscordPermissionOverwrite[],
  guildId: string,
  botUserId: string | undefined,
  memberAllow: bigint,
  memberDeny: bigint,
) {
  const privileged = new Map<string, number>([
    [DISCORD_ROLE_IDS.admin, 0],
    [DISCORD_ROLE_IDS.executive, 0],
    ...(botUserId ? ([[botUserId, 1]] as const) : []),
  ]);
  const byKey = new Map(
    overwrites.map((overwrite) => [
      `${overwrite.type}:${overwrite.id}`,
      { ...overwrite },
    ]),
  );

  byKey.set(
    `0:${guildId}`,
    applyControlledPermissions(
      byKey.get(`0:${guildId}`) ?? {
        allow: '0',
        deny: '0',
        id: guildId,
        type: 0,
      },
      memberAllow,
      memberDeny,
    ),
  );

  for (const [key, overwrite] of byKey) {
    if (
      key === `0:${guildId}` ||
      privileged.get(overwrite.id) === overwrite.type
    ) {
      continue;
    }
    byKey.set(key, {
      ...overwrite,
      allow: String(
        BigInt(overwrite.allow || '0') & ~WRITE_AND_REACTION_PERMISSIONS,
      ),
    });
  }

  for (const [id, type] of privileged) {
    const key = `${type}:${id}`;
    byKey.set(
      key,
      applyControlledPermissions(
        byKey.get(key) ?? { allow: '0', deny: '0', id, type },
        WRITE_AND_REACTION_PERMISSIONS,
        0n,
      ),
    );
  }

  return [...byKey.values()];
}

function applyControlledPermissions(
  overwrite: DiscordPermissionOverwrite,
  allow: bigint,
  deny: bigint,
) {
  return {
    ...overwrite,
    allow: String(
      (BigInt(overwrite.allow || '0') & ~WRITE_AND_REACTION_PERMISSIONS) |
        allow,
    ),
    deny: String(
      (BigInt(overwrite.deny || '0') & ~WRITE_AND_REACTION_PERMISSIONS) | deny,
    ),
  };
}

async function findCompetitionForum(
  env: Env,
  guildId: string,
  projection: CompetitionProjection,
  marker: string,
) {
  if (projection.forumChannelId) {
    const forum = await competitionDiscordRequest<DiscordChannel>(
      env,
      `/channels/${projection.forumChannelId}`,
    );
    assertCompetitionForum(forum, guildId, marker);
    return forum;
  }
  const channels = await competitionDiscordRequest<DiscordChannel[]>(
    env,
    `/guilds/${guildId}/channels`,
  );
  const matches = channels.filter(
    (channel) =>
      channel.type === FORUM_CHANNEL_TYPE && channel.topic?.startsWith(marker),
  );
  if (matches.length > 1) {
    throw new Error('Multiple Discord forums match this competition.');
  }
  return matches[0];
}

function assertCompetitionForum(
  forum: DiscordChannel,
  guildId: string,
  marker: string,
) {
  const allowedCategories = new Set<string>([
    DISCORD_CHANNEL_IDS.competitionActiveCategory,
    DISCORD_CHANNEL_IDS.competitionArchiveCategory,
  ]);
  if (
    forum.guild_id !== guildId ||
    forum.type !== FORUM_CHANNEL_TYPE ||
    !forum.topic?.startsWith(marker) ||
    !forum.parent_id ||
    !allowedCategories.has(forum.parent_id)
  ) {
    throw new Error('Discord competition forum identity did not match.');
  }
}

async function updateCompetitionForum(
  env: Env,
  forum: DiscordChannel,
  projection: CompetitionProjection,
  marker: string,
  activePermissionOverwrites: DiscordPermissionOverwrite[] | undefined,
) {
  const body: Record<string, unknown> = {
    default_reaction_emoji:
      projection.status === 'judging'
        ? { emoji_name: COMPETITION_VOTE_EMOJI }
        : null,
    name: normalizeCompetitionForumName(projection.title),
    topic: marker,
  };
  if (activePermissionOverwrites) {
    body.permission_overwrites = activePermissionOverwrites;
  }
  if (projection.status !== 'closed') {
    body.parent_id = DISCORD_CHANNEL_IDS.competitionActiveCategory;
  }
  return competitionDiscordRequest<DiscordChannel>(
    env,
    `/channels/${forum.id}`,
    {
      body: JSON.stringify(body),
      method: 'PATCH',
    },
  );
}

async function getActiveCompetitionPermissionOverwrites(
  env: Env,
  guildId: string,
  botUserId: string,
  status: 'draft' | 'judging' | 'open',
) {
  const activeCategory = await competitionDiscordRequest<DiscordChannel>(
    env,
    `/channels/${DISCORD_CHANNEL_IDS.competitionActiveCategory}`,
  );
  return buildActiveCompetitionForumOverwrites(
    activeCategory.permission_overwrites ?? [],
    guildId,
    status,
    botUserId,
  );
}

async function upsertCompetitionStatusPost(
  env: Env,
  guildId: string,
  forumChannelId: string,
  projection: CompetitionProjection,
) {
  const message = buildCompetitionStatusMessage(projection, guildId);
  if (projection.statusThreadId && projection.statusMessageId) {
    await competitionDiscordRequest(
      env,
      `/channels/${projection.statusThreadId}`,
      {
        body: JSON.stringify({ archived: false, flags: 2, locked: false }),
        method: 'PATCH',
      },
    );
    await competitionDiscordRequest(
      env,
      `/channels/${projection.statusThreadId}/messages/${projection.statusMessageId}`,
      { body: JSON.stringify(message), method: 'PATCH' },
    );
    return {
      messageId: projection.statusMessageId,
      threadId: projection.statusThreadId,
    };
  }

  const existingStatus = await findCompetitionStatusPost(
    env,
    guildId,
    forumChannelId,
  );
  if (existingStatus) {
    await competitionDiscordRequest(
      env,
      `/channels/${existingStatus.threadId}`,
      {
        body: JSON.stringify({ archived: false, flags: 2, locked: false }),
        method: 'PATCH',
      },
    );
    await competitionDiscordRequest(
      env,
      `/channels/${existingStatus.threadId}/messages/${existingStatus.messageId}`,
      { body: JSON.stringify(message), method: 'PATCH' },
    );
    return existingStatus;
  }

  const created = await competitionDiscordRequest<DiscordChannel>(
    env,
    `/channels/${forumChannelId}/threads`,
    {
      body: JSON.stringify({
        auto_archive_duration: 10_080,
        message,
        name: 'Competition status',
      }),
      method: 'POST',
    },
  );
  await competitionDiscordRequest(env, `/channels/${created.id}`, {
    body: JSON.stringify({ flags: 2 }),
    method: 'PATCH',
  });
  return {
    messageId: created.message?.id ?? created.id,
    threadId: created.id,
  };
}

async function reconcileCompetitionEntryReactions(
  env: Env,
  forumChannelId: string,
  projection: CompetitionProjection,
) {
  const placements = new Map(
    projection.results.map((result) => [
      `${result.threadId}:${result.messageId}`,
      result.place,
    ]),
  );

  for (const entry of projection.entries) {
    const thread = await tryCompetitionDiscordRequest<DiscordChannel>(
      env,
      `/channels/${entry.threadId}`,
    );
    if (!thread) continue;
    if (thread.parent_id !== forumChannelId) {
      throw new Error('Competition entry does not belong to its forum.');
    }

    const isActive =
      thread.thread_metadata?.archived === false &&
      thread.thread_metadata.locked === false;
    const activeThread = isActive
      ? thread
      : await tryCompetitionDiscordRequest(env, `/channels/${entry.threadId}`, {
          body: JSON.stringify({ archived: false, locked: false }),
          method: 'PATCH',
        });
    if (!activeThread) continue;

    if (projection.status === 'judging') {
      await removeUnexpectedCompetitionReactions(env, entry);
    } else {
      await tryCompetitionDiscordRequest(
        env,
        `/channels/${entry.threadId}/messages/${entry.messageId}/reactions`,
        { method: 'DELETE' },
      );
    }

    const emoji =
      projection.status === 'judging'
        ? COMPETITION_VOTE_EMOJI
        : projection.status === 'closed'
          ? PLACEMENT_EMOJI[
              placements.get(`${entry.threadId}:${entry.messageId}`) ?? 0
            ]
          : undefined;
    if (emoji) {
      await tryCompetitionDiscordRequest(
        env,
        `/channels/${entry.threadId}/messages/${entry.messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
        { method: 'PUT' },
      );
    }

    if (projection.status === 'closed') {
      await tryCompetitionDiscordRequest(env, `/channels/${entry.threadId}`, {
        body: JSON.stringify({ archived: true, locked: true }),
        method: 'PATCH',
      });
    }
  }
}

async function removeUnexpectedCompetitionReactions(
  env: Env,
  entry: CompetitionProjection['entries'][number],
) {
  const message = await tryCompetitionDiscordRequest<DiscordMessage>(
    env,
    `/channels/${entry.threadId}/messages/${entry.messageId}`,
  );
  if (!message) return;

  for (const reaction of message.reactions ?? []) {
    const emoji = formatDiscordReactionEmoji(reaction.emoji);
    if (!emoji || isCompetitionVoteEmoji(emoji)) continue;
    await tryCompetitionDiscordRequest(
      env,
      `/channels/${entry.threadId}/messages/${entry.messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'DELETE' },
    );
  }
}

function formatDiscordReactionEmoji(
  emoji: { id?: string | null; name?: string | null } | undefined,
) {
  const name = emoji?.name?.trim();
  if (!name) return null;
  return emoji?.id ? `${name}:${emoji.id}` : name;
}

function isCompetitionVoteEmoji(emoji: string) {
  return (
    emoji.replaceAll('\uFE0F', '') ===
    COMPETITION_VOTE_EMOJI.replaceAll('\uFE0F', '')
  );
}

async function tryCompetitionDiscordRequest<T = unknown>(
  env: Env,
  path: string,
  init: RequestInit = {},
) {
  try {
    return await competitionDiscordRequest<T>(env, path, init);
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) return null;
    throw error;
  }
}

export async function archiveDiscordCompetition(
  env: Env,
  event: CompetitionArchiveInternalEvent,
) {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const botUserId = getRequiredEnv(env, 'DISCORD_APPLICATION_ID');
  const forum = await competitionDiscordRequest<DiscordChannel>(
    env,
    `/channels/${event.forumChannelId}`,
  );
  assertCompetitionForum(
    forum,
    guildId,
    `pcc-competition:${event.competitionId}`,
  );
  if (readMarkerRevision(forum.topic) !== event.syncRevision) {
    throw new Error('Discord competition forum revision did not match.');
  }
  const archiveCategory = await competitionDiscordRequest<DiscordChannel>(
    env,
    `/channels/${DISCORD_CHANNEL_IDS.competitionArchiveCategory}`,
  );
  await competitionDiscordRequest(env, `/channels/${event.forumChannelId}`, {
    body: JSON.stringify({
      default_reaction_emoji: null,
      parent_id: DISCORD_CHANNEL_IDS.competitionArchiveCategory,
      permission_overwrites: buildReadOnlyOverwrites(
        archiveCategory.permission_overwrites?.length
          ? archiveCategory.permission_overwrites
          : [{ allow: '0', deny: '0', id: guildId, type: 0 }],
        guildId,
        botUserId,
      ),
    }),
    method: 'PATCH',
  });
  return { forumChannelId: event.forumChannelId };
}

async function findCompetitionStatusPost(
  env: Env,
  guildId: string,
  forumChannelId: string,
) {
  const active = await competitionDiscordRequest<DiscordThreadList>(
    env,
    `/guilds/${guildId}/threads/active`,
  );
  const archived = await competitionDiscordRequest<DiscordThreadList>(
    env,
    `/channels/${forumChannelId}/threads/archived/public?limit=100`,
  );
  const matches = [
    ...(active.threads ?? []),
    ...(archived.threads ?? []),
  ].filter(
    (thread) =>
      thread.parent_id === forumChannelId &&
      thread.name === 'Competition status',
  );
  if (matches.length > 1)
    throw new Error('Multiple competition status posts were found.');
  const thread = matches[0];
  return thread ? { messageId: thread.id, threadId: thread.id } : null;
}

function competitionDiscordRequest<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return retryDiscordRateLimitedOperation(
    () => discordApiRequest<T>(env, path, init),
    { maxRetries: 1, maxRetryDelayMs: 15_000 },
  );
}

function readMarkerRevision(topic: string | null | undefined) {
  const match = /;revision:(\d+)$/.exec(topic ?? '');
  return match ? Number(match[1]) : 0;
}

function formatDiscordDeadline(dateOnly: string) {
  const date = new Date(`${dateOnly}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return dateOnly;

  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(date);
}

function escapeDiscordText(value: string) {
  return value.replace(/[\\*_~`>|[\]()#@]/g, '\\$&');
}
