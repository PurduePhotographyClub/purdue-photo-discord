/**
 * Keeps photographer request embeds in sync with Discord reactions.
 */
import type { DiscordEmbed, Env } from '../discord/types';
import type { GatewayInternalEvent } from '@pccbot/shared';
import { discordApiRequest } from '../discord/api';
import { PHOTOGRAPHER_REQUEST_CHANNEL_IDS } from '../config/discord-channel-ids';
import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import { editDiscordMessage } from './discordMessageService';
import { createLogger } from '../utils/logger';

type PhotographerRequestStatus =
  | 'OPEN'
  | 'REACHED'
  | 'ACCEPTED'
  | 'CANCELLED'
  | 'EXPIRED';

interface DiscordMessageResponse {
  content?: string;
  embeds?: DiscordEmbed[];
  id?: string;
}

interface DiscordUserResponse {
  bot?: boolean;
  discriminator?: string;
  global_name?: string | null;
  id?: string;
  username?: string;
}

interface DiscordGuildMemberResponse {
  nick?: string | null;
  roles?: string[];
  user?: DiscordUserResponse;
}

interface ReactionParticipant {
  id: string;
  name: string;
  roles: string[];
}

export interface PhotographerRequestExpirySweepOptions {
  channelIds?: readonly string[];
  maxPagesPerChannel?: number;
  now?: Date;
}

export interface PhotographerRequestExpirySweepResult {
  channels: number;
  expired: number;
  failed: number;
  scanned: number;
  skipped: number;
}

const logger = createLogger('photographer-requests');

const PHOTOGRAPHER_REQUEST_FOOTER = 'PPC photographer request';
const PHOTOGRAPHER_REQUEST_PAGE_SIZE = 100;
const DEFAULT_EXPIRY_SWEEP_MAX_PAGES = 3;
const MAX_EXPIRY_SWEEP_PAGES = 10;
const CLUB_TIME_ZONE = 'America/Indiana/Indianapolis';
const EXPIRED_NOTICE =
  'This job has expired, but you can still contact the owner.';
const EYES_EMOJI = '👀';
const CAMERA_EMOJI = '📸';
const CANCEL_EMOJI = '❌';

const STATUS_EMOJIS = new Set([EYES_EMOJI, CAMERA_EMOJI, CANCEL_EMOJI]);
const STATUS_FIELD_NAMES = new Set([
  'Accepted By',
  'Cancelled By',
  'Expired',
  'Reached By',
  'Status',
]);

const STATUS_COLORS: Record<PhotographerRequestStatus, number> = {
  ACCEPTED: 0x3fb950,
  CANCELLED: 0xf85149,
  EXPIRED: 0x8b949e,
  OPEN: 0x58a6ff,
  REACHED: 0xf5c542,
};

const FINAL_STATUSES = new Set<PhotographerRequestStatus>([
  'ACCEPTED',
  'CANCELLED',
  'EXPIRED',
]);

export async function sweepExpiredPhotographerRequests(
  env: Env,
  options: PhotographerRequestExpirySweepOptions = {},
): Promise<PhotographerRequestExpirySweepResult> {
  const channelIds = options.channelIds ?? [
    ...PHOTOGRAPHER_REQUEST_CHANNEL_IDS,
  ];
  const now = options.now ?? new Date();
  const maxPagesPerChannel = normalizeMaxPages(options.maxPagesPerChannel);
  const results = await Promise.all(
    channelIds.map((channelId) =>
      sweepExpiredPhotographerRequestsInChannel(env, channelId, {
        maxPagesPerChannel,
        now,
      }),
    ),
  );
  const summary = results.reduce<PhotographerRequestExpirySweepResult>(
    (accumulator, result) => ({
      channels: accumulator.channels + result.channels,
      expired: accumulator.expired + result.expired,
      failed: accumulator.failed + result.failed,
      scanned: accumulator.scanned + result.scanned,
      skipped: accumulator.skipped + result.skipped,
    }),
    {
      channels: 0,
      expired: 0,
      failed: 0,
      scanned: 0,
      skipped: 0,
    },
  );

  logger.info('Swept expired photographer requests.', summary);

  return summary;
}

export async function handlePhotographerRequestReaction(
  event: GatewayInternalEvent,
  env: Env,
): Promise<{ handled: boolean }> {
  if (!isStatusReactionEvent(event)) {
    return { handled: false };
  }

  const channelId = event.channelId;
  const messageId = event.messageId;
  if (
    !channelId ||
    !messageId ||
    !PHOTOGRAPHER_REQUEST_CHANNEL_IDS.has(channelId)
  ) {
    return { handled: false };
  }

  try {
    const message = await getDiscordMessage(env, channelId, messageId);
    const embed = message.embeds?.[0];

    if (!isPhotographerRequestEmbed(embed)) {
      return { handled: false };
    }

    const guildId = event.guildId ?? env.DISCORD_GUILD_ID;
    const [reachedBy, acceptedBy, cancelledBy] = await Promise.all([
      getReactionParticipants(env, channelId, messageId, guildId, EYES_EMOJI),
      getReactionParticipants(env, channelId, messageId, guildId, CAMERA_EMOJI),
      getReactionParticipants(
        env,
        channelId,
        messageId,
        guildId,
        CANCEL_EMOJI,
        {
          requireExecutive: true,
        },
      ),
    ]);

    const status = resolveReactionStatus(
      embed,
      getStatus({ acceptedBy, cancelledBy, reachedBy }),
    );
    const updatedEmbed = buildUpdatedEmbed(embed, {
      acceptedBy,
      cancelledBy,
      reachedBy,
      status,
    });

    await editDiscordMessage(env, {
      channelId,
      content: ``,
      embeds: [updatedEmbed],
      messageId,
    });

    logger.info('Updated photographer request status.', {
      acceptedCount: acceptedBy.length,
      cancelledCount: cancelledBy.length,
      channelId,
      messageId,
      reachedCount: reachedBy.length,
      status,
    });

    return { handled: true };
  } catch (error) {
    logger.error('Failed to update photographer request status.', {
      channelId,
      error,
      messageId,
    });

    return { handled: false };
  }
}

async function sweepExpiredPhotographerRequestsInChannel(
  env: Env,
  channelId: string,
  options: {
    maxPagesPerChannel: number;
    now: Date;
  },
): Promise<PhotographerRequestExpirySweepResult> {
  const result: PhotographerRequestExpirySweepResult = {
    channels: 1,
    expired: 0,
    failed: 0,
    scanned: 0,
    skipped: 0,
  };
  let before: string | undefined;

  for (let page = 0; page < options.maxPagesPerChannel; page += 1) {
    let messages: DiscordMessageResponse[];
    try {
      messages = await getDiscordChannelMessages(env, channelId, before);
    } catch (error) {
      result.failed += 1;
      logger.error('Failed to read photographer request channel.', {
        channelId,
        error,
      });
      break;
    }

    if (messages.length === 0) {
      break;
    }

    for (const message of messages) {
      const embed = message.embeds?.[0];
      if (!message.id || !isPhotographerRequestEmbed(embed)) {
        continue;
      }

      result.scanned += 1;

      if (!shouldExpirePhotographerRequest(embed, options.now)) {
        result.skipped += 1;
        continue;
      }

      try {
        await editDiscordMessage(env, {
          channelId,
          embeds: [
            buildUpdatedEmbed(embed, {
              acceptedBy: [],
              cancelledBy: [],
              reachedBy: [],
              status: 'EXPIRED',
            }),
          ],
          messageId: message.id,
        });
        result.expired += 1;
      } catch (error) {
        result.failed += 1;
        logger.error('Failed to mark photographer request expired.', {
          channelId,
          error,
          messageId: message.id,
        });
      }
    }

    if (messages.length < PHOTOGRAPHER_REQUEST_PAGE_SIZE) {
      break;
    }

    before = messages[messages.length - 1]?.id;
    if (!before) {
      break;
    }
  }

  return result;
}

async function getDiscordChannelMessages(
  env: Env,
  channelId: string,
  before: string | undefined,
) {
  const searchParams = new URLSearchParams({
    limit: String(PHOTOGRAPHER_REQUEST_PAGE_SIZE),
  });
  if (before) {
    searchParams.set('before', before);
  }

  return discordApiRequest<DiscordMessageResponse[]>(
    env,
    `/channels/${channelId}/messages?${searchParams.toString()}`,
  );
}

function isStatusReactionEvent(event: GatewayInternalEvent) {
  return (
    (event.eventType === 'MESSAGE_REACTION_ADD' ||
      event.eventType === 'MESSAGE_REACTION_REMOVE' ||
      event.eventType === 'MESSAGE_REACTION_REMOVE_EMOJI') &&
    STATUS_EMOJIS.has(readEmojiName(event.payload) ?? '')
  );
}

async function getDiscordMessage(
  env: Env,
  channelId: string,
  messageId: string,
) {
  return discordApiRequest<DiscordMessageResponse>(
    env,
    `/channels/${channelId}/messages/${messageId}`,
  );
}

async function getReactionParticipants(
  env: Env,
  channelId: string,
  messageId: string,
  guildId: string | undefined,
  emoji: string,
  options: { requireExecutive?: boolean } = {},
): Promise<ReactionParticipant[]> {
  const users = await getReactionUsers(env, channelId, messageId, emoji);
  const participants = await Promise.all(
    users
      .filter(
        (user): user is DiscordUserResponse & { id: string } =>
          Boolean(user.id) && user.bot !== true,
      )
      .map(async (user) => {
        const member = guildId
          ? await getGuildMember(env, guildId, user.id)
          : null;
        const roles = member?.roles ?? [];

        if (
          options.requireExecutive &&
          !roles.includes(DISCORD_ROLE_IDS.executive)
        ) {
          return null;
        }

        return {
          id: user.id,
          name: formatParticipantName(user, member),
          roles,
        };
      }),
  );

  return uniqueParticipants(
    participants.filter((item): item is ReactionParticipant => item !== null),
  );
}

async function getReactionUsers(
  env: Env,
  channelId: string,
  messageId: string,
  emoji: string,
) {
  try {
    return await discordApiRequest<DiscordUserResponse[]>(
      env,
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100`,
    );
  } catch (error) {
    logger.warn('Unable to read photographer request reactions.', {
      channelId,
      emoji,
      error,
      messageId,
    });

    return [];
  }
}

async function getGuildMember(
  env: Env,
  guildId: string,
  userId: string,
): Promise<DiscordGuildMemberResponse | null> {
  try {
    return await discordApiRequest<DiscordGuildMemberResponse>(
      env,
      `/guilds/${guildId}/members/${userId}`,
    );
  } catch {
    return null;
  }
}

function getStatus(options: {
  acceptedBy: ReactionParticipant[];
  cancelledBy: ReactionParticipant[];
  reachedBy: ReactionParticipant[];
}): PhotographerRequestStatus {
  if (options.cancelledBy.length) {
    return 'CANCELLED';
  }

  if (options.acceptedBy.length) {
    return 'ACCEPTED';
  }

  if (options.reachedBy.length) {
    return 'REACHED';
  }

  return 'OPEN';
}

function resolveReactionStatus(
  embed: DiscordEmbed,
  reactionStatus: PhotographerRequestStatus,
): PhotographerRequestStatus {
  const currentStatus = readPhotographerRequestStatus(embed);
  if (
    currentStatus === 'EXPIRED' &&
    (reactionStatus === 'OPEN' || reactionStatus === 'REACHED')
  ) {
    return 'EXPIRED';
  }

  return reactionStatus;
}

function buildUpdatedEmbed(
  embed: DiscordEmbed,
  options: {
    acceptedBy: ReactionParticipant[];
    cancelledBy: ReactionParticipant[];
    reachedBy: ReactionParticipant[];
    status: PhotographerRequestStatus;
  },
): DiscordEmbed {
  const originalFields = (embed.fields ?? []).filter(
    (field) => !STATUS_FIELD_NAMES.has(field.name),
  );
  const statusFields: NonNullable<DiscordEmbed['fields']> = [
    {
      inline: true,
      name: 'Status',
      value: options.status,
    },
  ];

  if (options.status === 'EXPIRED') {
    statusFields.push({
      name: 'Expired',
      value: EXPIRED_NOTICE,
    });
  }

  if (options.reachedBy.length) {
    statusFields.push({
      name: 'Reached By',
      value: formatParticipants(options.reachedBy),
    });
  }

  if (options.acceptedBy.length) {
    statusFields.push({
      name: 'Accepted By',
      value: formatParticipants(options.acceptedBy),
    });
  }

  if (options.cancelledBy.length) {
    statusFields.push({
      name: 'Cancelled By',
      value: formatParticipants(options.cancelledBy),
    });
  }

  return {
    ...embed,
    color: STATUS_COLORS[options.status],
    fields: [...statusFields, ...originalFields].slice(0, 25),
    footer: {
      text: PHOTOGRAPHER_REQUEST_FOOTER,
    },
  };
}

function isPhotographerRequestEmbed(
  embed: DiscordEmbed | undefined,
): embed is DiscordEmbed {
  return embed?.footer?.text === PHOTOGRAPHER_REQUEST_FOOTER;
}

function shouldExpirePhotographerRequest(embed: DiscordEmbed, now: Date) {
  const status = readPhotographerRequestStatus(embed);
  if (status && FINAL_STATUSES.has(status)) {
    return false;
  }

  return isPhotographerRequestEventExpired(embed, now);
}

function isPhotographerRequestEventExpired(embed: DiscordEmbed, now: Date) {
  const eventDate = readEmbedField(embed, 'Date');
  if (!eventDate || !isPlainDate(eventDate)) {
    return false;
  }

  const currentDateTime = getClubLocalDateTime(now);
  if (eventDate < currentDateTime.date) {
    return true;
  }

  if (eventDate > currentDateTime.date) {
    return false;
  }

  const endTime = readEmbedField(embed, 'End Time');
  return !!endTime && isPlainTime(endTime) && endTime <= currentDateTime.time;
}

function readPhotographerRequestStatus(
  embed: DiscordEmbed,
): PhotographerRequestStatus | null {
  const status = readEmbedField(embed, 'Status')?.toUpperCase();
  if (
    status === 'OPEN' ||
    status === 'REACHED' ||
    status === 'ACCEPTED' ||
    status === 'CANCELLED' ||
    status === 'EXPIRED'
  ) {
    return status;
  }

  return null;
}

function readEmbedField(embed: DiscordEmbed, name: string) {
  return embed.fields?.find((field) => field.name === name)?.value.trim();
}

function getClubLocalDateTime(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: CLUB_TIME_ZONE,
    year: 'numeric',
  }).formatToParts(date);
  const partMap = new Map(parts.map((part) => [part.type, part.value]));
  const year = partMap.get('year') ?? '0000';
  const month = partMap.get('month') ?? '00';
  const day = partMap.get('day') ?? '00';
  const hour = partMap.get('hour') ?? '00';
  const minute = partMap.get('minute') ?? '00';

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
  };
}

function isPlainDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  return !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime());
}

function isPlainTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizeMaxPages(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_EXPIRY_SWEEP_MAX_PAGES;
  }

  return Math.min(Math.floor(value), MAX_EXPIRY_SWEEP_PAGES);
}

function formatParticipantName(
  user: DiscordUserResponse & { id: string },
  member: DiscordGuildMemberResponse | null,
) {
  return sanitizeDiscordText(
    member?.nick ||
      member?.user?.global_name ||
      user.global_name ||
      user.username ||
      `Discord user ${user.id}`,
  );
}

function formatParticipants(participants: ReactionParticipant[]) {
  return truncate(
    participants.map((participant) => participant.name).join('\n'),
    1_024,
  );
}

function uniqueParticipants(participants: ReactionParticipant[]) {
  const seen = new Set<string>();
  const unique: ReactionParticipant[] = [];

  for (const participant of participants) {
    if (seen.has(participant.id)) {
      continue;
    }

    seen.add(participant.id);
    unique.push(participant);
  }

  return unique.sort((left, right) => left.name.localeCompare(right.name));
}

function readEmojiName(payload: Record<string, unknown>): string | undefined {
  const emoji = payload.emoji;

  if (!isRecord(emoji)) {
    return undefined;
  }

  return typeof emoji.name === 'string' ? emoji.name : undefined;
}

function sanitizeDiscordText(value: string) {
  return (
    Array.from(value)
      .filter(isVisibleTextCharacter)
      .join('')
      .replace(/@/g, '@\u200b')
      .trim()
      .slice(0, 120) || 'Unknown Discord user'
  );
}

function isVisibleTextCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
