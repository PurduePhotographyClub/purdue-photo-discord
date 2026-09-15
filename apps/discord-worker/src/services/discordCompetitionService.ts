import { discordApiRequest } from '../discord/api';
import type { Env } from '../discord/types';
import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { getRequiredEnv } from '../utils/env';
import type { CompetitionSyncInternalEvent } from '../internal-events/types';
import { DiscordApiError } from '../utils/errors';

type CompetitionProjection = CompetitionSyncInternalEvent['competition'];

interface DiscordPermissionOverwrite {
  allow: string;
  deny: string;
  id: string;
  type: number;
}

interface DiscordChannel {
  id: string;
  message?: { id?: string };
  name?: string;
  parent_id?: string | null;
  permission_overwrites?: DiscordPermissionOverwrite[];
  topic?: string | null;
  type?: number;
}

interface DiscordThreadList {
  threads?: DiscordChannel[];
}

const FORUM_CHANNEL_TYPE = 15;
const WRITE_AND_REACTION_PERMISSIONS =
  64n | 2_048n | 34_359_738_368n | 68_719_476_736n | 274_877_906_944n;
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
    await discordApiRequest(env, `/channels/${forumChannelId}`, {
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
  const baseMarker = `pcc-competition:${projection.id}`;
  const marker = `${baseMarker};revision:${projection.syncRevision}`;
  let forum = await findCompetitionForum(env, guildId, projection, baseMarker);

  if (!forum) {
    forum = await discordApiRequest<DiscordChannel>(
      env,
      `/guilds/${guildId}/channels`,
      {
        body: JSON.stringify({
          name: normalizeCompetitionForumName(projection.title),
          parent_id: DISCORD_CHANNEL_IDS.competitionActiveCategory,
          topic: marker,
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

  const activeForum = await updateCompetitionForum(
    env,
    forum,
    projection,
    marker,
  );
  const status = await upsertCompetitionStatusPost(
    env,
    guildId,
    activeForum.id,
    projection,
  );

  if (projection.status === 'closed') {
    await addPlacementReactions(env, projection);
    await archiveCompetitionForum(
      env,
      guildId,
      activeForum.id,
      projection.title,
      marker,
    );
  }

  return {
    forumChannelId: activeForum.id,
    statusMessageId: status.messageId,
    statusThreadId: status.threadId,
  };
}

export function buildCompetitionStatusContent(
  projection: CompetitionProjection,
) {
  const state = {
    closed: 'Ended',
    draft: 'Draft',
    judging: 'Voting',
    open: 'Open for entries',
  }[projection.status];
  const deadline = projection.submissionDeadline
    ? formatDiscordDeadline(projection.submissionDeadline)
    : 'Not set';
  const lines = [
    `**${escapeDiscordText(projection.title)}**`,
    `Status: ${state}`,
    `Deadline: ${deadline}`,
    ...(projection.theme
      ? [`Theme: ${escapeDiscordText(projection.theme)}`]
      : []),
    '',
    'One entry per person.',
    'Use the photo title as the post title.',
    'Write one short line about the image.',
    'Attach exactly one image.',
  ];

  if (projection.status === 'judging') {
    lines.push('', 'Voting is open. React to individual entry posts to vote.');
  }
  if (projection.status === 'closed' && projection.results.length > 0) {
    const guildId = '1182061172309106708';
    lines.push('', '**Results**');
    for (const result of [...projection.results].sort(
      (a, b) => a.place - b.place,
    )) {
      lines.push(
        `${PLACEMENT_EMOJI[result.place] ?? `${result.place}.`} ${escapeDiscordText(result.title)} — https://discord.com/channels/${guildId}/${result.threadId}/${result.messageId}`,
      );
    }
  }

  return lines.join('\n').slice(0, 2_000);
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
): DiscordPermissionOverwrite[] {
  return overwrites.map((overwrite) => ({
    ...overwrite,
    allow: String(
      BigInt(overwrite.allow || '0') & ~WRITE_AND_REACTION_PERMISSIONS,
    ),
    deny: String(
      BigInt(overwrite.deny || '0') | WRITE_AND_REACTION_PERMISSIONS,
    ),
  }));
}

async function findCompetitionForum(
  env: Env,
  guildId: string,
  projection: CompetitionProjection,
  marker: string,
) {
  if (projection.forumChannelId) {
    return discordApiRequest<DiscordChannel>(
      env,
      `/channels/${projection.forumChannelId}`,
    );
  }
  const channels = await discordApiRequest<DiscordChannel[]>(
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

async function updateCompetitionForum(
  env: Env,
  forum: DiscordChannel,
  projection: CompetitionProjection,
  marker: string,
) {
  const body: Record<string, unknown> = {
    default_reaction_emoji:
      projection.status === 'judging' ? { emoji_name: '❤️' } : null,
    name: normalizeCompetitionForumName(projection.title),
    topic: marker,
  };
  if (projection.status !== 'closed') {
    body.parent_id = DISCORD_CHANNEL_IDS.competitionActiveCategory;
  }
  return discordApiRequest<DiscordChannel>(env, `/channels/${forum.id}`, {
    body: JSON.stringify(body),
    method: 'PATCH',
  });
}

async function upsertCompetitionStatusPost(
  env: Env,
  guildId: string,
  forumChannelId: string,
  projection: CompetitionProjection,
) {
  const message = {
    allowed_mentions: { parse: [] },
    content: buildCompetitionStatusContent(projection),
  };
  if (projection.statusThreadId && projection.statusMessageId) {
    await discordApiRequest(env, `/channels/${projection.statusThreadId}`, {
      body: JSON.stringify({ archived: false, flags: 2, locked: false }),
      method: 'PATCH',
    });
    await discordApiRequest(
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
    await discordApiRequest(env, `/channels/${existingStatus.threadId}`, {
      body: JSON.stringify({ archived: false, flags: 2, locked: false }),
      method: 'PATCH',
    });
    await discordApiRequest(
      env,
      `/channels/${existingStatus.threadId}/messages/${existingStatus.messageId}`,
      { body: JSON.stringify(message), method: 'PATCH' },
    );
    return existingStatus;
  }

  const created = await discordApiRequest<DiscordChannel>(
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
  await discordApiRequest(env, `/channels/${created.id}`, {
    body: JSON.stringify({ flags: 2 }),
    method: 'PATCH',
  });
  return {
    messageId: created.message?.id ?? created.id,
    threadId: created.id,
  };
}

async function addPlacementReactions(
  env: Env,
  projection: CompetitionProjection,
) {
  for (const result of projection.results) {
    const emoji = PLACEMENT_EMOJI[result.place];
    if (!emoji) continue;
    await discordApiRequest(
      env,
      `/channels/${result.threadId}/messages/${result.messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: 'PUT' },
    );
  }
}

async function archiveCompetitionForum(
  env: Env,
  guildId: string,
  forumChannelId: string,
  title: string,
  marker: string,
) {
  const archiveCategory = await discordApiRequest<DiscordChannel>(
    env,
    `/channels/${DISCORD_CHANNEL_IDS.competitionArchiveCategory}`,
  );
  await discordApiRequest(env, `/channels/${forumChannelId}`, {
    body: JSON.stringify({
      default_reaction_emoji: null,
      name: normalizeCompetitionForumName(title),
      parent_id: DISCORD_CHANNEL_IDS.competitionArchiveCategory,
      permission_overwrites: buildReadOnlyOverwrites(
        archiveCategory.permission_overwrites?.length
          ? archiveCategory.permission_overwrites
          : [{ allow: '0', deny: '0', id: guildId, type: 0 }],
      ),
      topic: marker,
    }),
    method: 'PATCH',
  });
}

async function findCompetitionStatusPost(
  env: Env,
  guildId: string,
  forumChannelId: string,
) {
  const active = await discordApiRequest<DiscordThreadList>(
    env,
    `/guilds/${guildId}/threads/active`,
  );
  const archived = await discordApiRequest<DiscordThreadList>(
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
