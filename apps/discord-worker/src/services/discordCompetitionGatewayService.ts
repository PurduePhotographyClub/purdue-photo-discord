import type { GatewayInternalEvent } from '@pccbot/shared';
import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { discordApiRequest } from '../discord/api';
import type { Env } from '../discord/types';
import { DiscordApiError } from '../utils/errors';
import { COMPETITION_VOTE_EMOJI } from './discordCompetitionService';
import { requestWebsiteApi } from './websiteApiService';

interface CompetitionPolicy {
  canReact?: boolean;
  found?: boolean;
  isEntry?: boolean;
  status?: string;
  existingEntry?: { messageId: string; threadId: string } | null;
}

interface DiscordAttachment {
  content_type?: string | undefined;
  filename?: string | undefined;
  size?: number | undefined;
  url?: string | undefined;
}

const COMPETITION_CATEGORIES = new Set<string>([
  DISCORD_CHANNEL_IDS.competitionActiveCategory,
  DISCORD_CHANNEL_IDS.competitionArchiveCategory,
]);

export async function handleCompetitionGatewayEvent(
  event: GatewayInternalEvent,
  env: Env,
): Promise<{ handled: boolean }> {
  const categoryId = readString(event.payload.category_id);
  const forumChannelId = readString(event.payload.parent_channel_id);
  if (
    !categoryId ||
    !forumChannelId ||
    !COMPETITION_CATEGORIES.has(categoryId)
  ) {
    return { handled: false };
  }

  if (event.eventType === 'MESSAGE_CREATE') {
    return handleCompetitionEntryCreate(event, env, categoryId, forumChannelId);
  }
  if (event.eventType === 'MESSAGE_REACTION_ADD') {
    return handleCompetitionReaction(event, env, forumChannelId);
  }
  return { handled: false };
}

async function handleCompetitionEntryCreate(
  event: GatewayInternalEvent,
  env: Env,
  categoryId: string,
  forumChannelId: string,
) {
  const policy = await getForumPolicy(env, forumChannelId, event.userId);
  if (!policy.found) return { handled: false };

  const threadId = event.channelId;
  const messageId = event.messageId;
  const userId = event.userId;
  if (!threadId || !messageId || !userId || messageId !== threadId) {
    return { handled: true };
  }
  if (
    policy.existingEntry?.threadId === threadId &&
    policy.existingEntry.messageId === messageId
  ) {
    return { handled: true };
  }

  const title = readString(event.payload.thread_name);
  const description = readString(event.payload.content);
  const attachments = readAttachments(event.payload.attachments);
  const attachment = attachments[0];
  const valid =
    categoryId === DISCORD_CHANNEL_IDS.competitionActiveCategory &&
    policy.status === 'open' &&
    Boolean(title && title.length <= 100) &&
    Boolean(
      description && description.length <= 240 && !/[\r\n]/.test(description),
    ) &&
    attachments.length === 1 &&
    Boolean(attachment?.url) &&
    isImageAttachment(attachment!);

  if (!valid) {
    await rejectCompetitionThread(
      env,
      threadId,
      userId,
      'Competition entries need a photo title, one short description line, and exactly one image while entries are open.',
    );
    return { handled: true };
  }

  if (
    policy.existingEntry &&
    !(await releaseDeletedCompetitionEntry(
      env,
      forumChannelId,
      policy.existingEntry,
    ))
  ) {
    await rejectCompetitionThread(
      env,
      threadId,
      userId,
      'You already have an entry in this competition. Delete that post before submitting a replacement while entries are open.',
    );
    return { handled: true };
  }

  try {
    await requestWebsiteApi(env, '/api/competitions/discord-entries', {
      body: {
        actorDiscordId: userId,
        attachmentUrl: attachment!.url,
        description,
        discordDisplayName: readDiscordDisplayName(event.payload.author),
        discordUserId: userId,
        forumChannelId,
        messageId,
        submittedAt: readString(event.payload.timestamp) ?? event.receivedAt,
        threadId,
        title,
      },
      method: 'POST',
    });
  } catch {
    await rejectCompetitionThread(
      env,
      threadId,
      userId,
      'That entry could not be accepted. You may already have an entry, or the deadline may have passed.',
    );
  }
  return { handled: true };
}

async function handleCompetitionReaction(
  event: GatewayInternalEvent,
  env: Env,
  forumChannelId: string,
) {
  const threadId = event.channelId;
  const messageId = event.messageId;
  const userId = event.userId;
  if (!threadId || !messageId || !userId) return { handled: true };
  if (
    userId === env.DISCORD_APPLICATION_ID ||
    readBoolean(readRecord(event.payload.user)?.bot)
  ) {
    return { handled: true };
  }

  const canReact = await requestWebsiteApi(
    env,
    `/api/competitions/discord-policy?forumChannelId=${encodeURIComponent(forumChannelId)}&threadId=${encodeURIComponent(threadId)}`,
  )
    .then((response) => {
      const policy = response as CompetitionPolicy;
      return Boolean(
        policy.canReact &&
        policy.isEntry &&
        messageId === threadId &&
        isCompetitionVoteEmoji(readEmoji(event.payload.emoji)),
      );
    })
    .catch(() => false);
  if (canReact) {
    return { handled: true };
  }

  const emoji = readEmoji(event.payload.emoji);
  if (emoji) {
    try {
      await discordApiRequest(
        env,
        `/channels/${threadId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/${userId}`,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (!(error instanceof DiscordApiError) || error.status !== 404) {
        throw error;
      }
    }
  }
  return { handled: true };
}

async function releaseDeletedCompetitionEntry(
  env: Env,
  forumChannelId: string,
  entry: { messageId: string; threadId: string },
) {
  try {
    await discordApiRequest(
      env,
      `/channels/${entry.threadId}/messages/${entry.messageId}`,
    );
    return false;
  } catch (error) {
    if (!(error instanceof DiscordApiError) || error.status !== 404)
      throw error;
  }
  const result = await requestWebsiteApi(
    env,
    '/api/competitions/discord-entries',
    {
      body: {
        forumChannelId,
        messageId: entry.messageId,
        threadId: entry.threadId,
      },
      method: 'DELETE',
    },
  );
  return isRecord(result) && result.deleted === true;
}

async function getForumPolicy(
  env: Env,
  forumChannelId: string,
  discordUserId?: string,
) {
  const userQuery = discordUserId
    ? `&discordUserId=${encodeURIComponent(discordUserId)}`
    : '';
  return requestWebsiteApi(
    env,
    `/api/competitions/discord-policy?forumChannelId=${encodeURIComponent(forumChannelId)}${userQuery}`,
  ) as Promise<CompetitionPolicy>;
}

async function rejectCompetitionThread(
  env: Env,
  threadId: string,
  userId: string,
  reason: string,
) {
  try {
    const dm = await discordApiRequest<{ id: string }>(
      env,
      '/users/@me/channels',
      {
        body: JSON.stringify({ recipient_id: userId }),
        method: 'POST',
      },
    );
    await discordApiRequest(env, `/channels/${dm.id}/messages`, {
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        content: reason,
      }),
      method: 'POST',
    });
  } catch {
    // The post still has to be removed when the member has DMs disabled.
  }
  await discordApiRequest(env, `/channels/${threadId}`, { method: 'DELETE' });
}

function readAttachments(value: unknown): DiscordAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .slice(0, 2)
    .map((attachment) => ({
      content_type: readString(attachment.content_type) ?? undefined,
      filename: readString(attachment.filename) ?? undefined,
      size: typeof attachment.size === 'number' ? attachment.size : undefined,
      url: readString(attachment.url) ?? undefined,
    }));
}

function isImageAttachment(attachment: DiscordAttachment) {
  return (
    attachment.content_type?.startsWith('image/') === true ||
    /\.(?:avif|gif|jpe?g|png|webp)$/i.test(attachment.filename ?? '')
  );
}

function readEmoji(value: unknown) {
  if (!isRecord(value)) return null;
  const name = readString(value.name);
  const id = readString(value.id);
  return name ? (id ? `${name}:${id}` : name) : null;
}

function isCompetitionVoteEmoji(emoji: string | null) {
  return (
    emoji?.replaceAll('\uFE0F', '') ===
    COMPETITION_VOTE_EMOJI.replaceAll('\uFE0F', '')
  );
}

function readDiscordDisplayName(value: unknown) {
  if (!isRecord(value)) return null;
  return readString(value.global_name) ?? readString(value.username);
}

function readRecord(value: unknown) {
  return isRecord(value) ? value : null;
}

function readBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
