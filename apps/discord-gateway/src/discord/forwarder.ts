/**
 * Gets Discord Gateway events over to the Worker.
 *
 * This file should stay boring: filter, sanitize, forward. The Worker decides
 * what an event means for club workflows.
 */
import type { GatewayEventType, GatewayInternalEvent } from '@pccbot/shared';
import type { GatewayConfig } from '../config.js';
import { createSignedWorkerHeaders } from '../http/workerAuth.js';
import type { Logger } from '../utils/logger.js';

interface ForwardableGatewayEvent {
  eventType: GatewayEventType;
  payload: Record<string, unknown>;
}

const REACTION_EVENTS = new Set<GatewayEventType>([
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL',
  'MESSAGE_REACTION_REMOVE_EMOJI',
]);

const MESSAGE_EVENTS = new Set<GatewayEventType>([
  'MESSAGE_CREATE',
  'MESSAGE_DELETE',
  'MESSAGE_UPDATE',
]);

const MEMBER_EVENTS = new Set<GatewayEventType>([
  'GUILD_MEMBER_ADD',
  'GUILD_MEMBER_REMOVE',
  'GUILD_MEMBER_UPDATE',
]);

export class WorkerEventForwarder {
  constructor(
    private readonly config: GatewayConfig,
    private readonly logger: Logger,
  ) {}

  async forward(
    eventType: string | undefined,
    payload: unknown,
    botUserId: string | undefined,
  ): Promise<void> {
    // Every event crosses the same boundary: validate support, apply deployment
    // filters, remove data we do not need, then send the Worker contract.
    const event = this.toForwardableEvent(eventType, payload, botUserId);

    if (!event) {
      return;
    }

    const body: GatewayInternalEvent = {
      eventType: event.eventType,
      payload: event.payload,
      receivedAt: new Date().toISOString(),
      type: 'discord.gateway.event',
    };
    // Promote common identifiers to the top level so Worker handlers and logs do
    // not have to understand each event payload's nested Discord shape.
    const guildId = readString(event.payload, 'guild_id');
    const channelId = readString(event.payload, 'channel_id');
    const messageId =
      readString(event.payload, 'message_id') ??
      readString(event.payload, 'id');
    const userId =
      readString(event.payload, 'user_id') ??
      readNestedString(event.payload, 'author', 'id') ??
      readNestedString(event.payload, 'user', 'id');

    if (guildId) {
      body.guildId = guildId;
    }

    if (channelId) {
      body.channelId = channelId;
    }

    if (messageId) {
      body.messageId = messageId;
    }

    if (userId) {
      body.userId = userId;
    }

    await this.sendToWorker(body);
  }

  private toForwardableEvent(
    eventType: string | undefined,
    payload: unknown,
    botUserId: string | undefined,
  ): ForwardableGatewayEvent | undefined {
    // Discord event names and payloads arrive as loose data here. Narrow them
    // before any deploy-specific filtering or sanitizing happens.
    if (!isGatewayEventType(eventType) || !isRecord(payload)) {
      return undefined;
    }

    // The booleans below are operational guardrails: the gateway may be granted
    // broad intents, but only explicitly enabled event families are forwarded.
    if (!this.isEnabledEvent(eventType)) {
      return undefined;
    }

    if (!this.matchesConfiguredFilters(payload)) {
      return undefined;
    }

    if (!this.config.forwardBotEvents && isBotEvent(payload, botUserId)) {
      return undefined;
    }

    // Sanitize at the source process, before the payload leaves the VPS.
    return {
      eventType,
      payload: sanitizeGatewayPayload(eventType, payload, this.config),
    };
  }

  private isEnabledEvent(eventType: GatewayEventType): boolean {
    // Keep the mapping between Discord event families and env flags in one
    // place so adding future events does not spread flag logic around.
    if (REACTION_EVENTS.has(eventType)) {
      return this.config.forwardReactions;
    }

    if (MESSAGE_EVENTS.has(eventType)) {
      return this.config.forwardMessages;
    }

    if (MEMBER_EVENTS.has(eventType)) {
      return this.config.forwardMembers;
    }

    return false;
  }

  private matchesConfiguredFilters(payload: Record<string, unknown>): boolean {
    // Guild/channel filters are allowlists. Empty sets intentionally mean "let
    // all configured event families through."
    const guildId = readString(payload, 'guild_id');
    const channelId = readString(payload, 'channel_id');

    // Empty filter sets mean "all"; once configured, missing IDs should not slip
    // through because they cannot be proven to belong to the allowed scope.
    if (
      this.config.filters.guildIds.size > 0 &&
      (!guildId || !this.config.filters.guildIds.has(guildId))
    ) {
      return false;
    }

    if (
      this.config.filters.channelIds.size > 0 &&
      (!channelId || !this.config.filters.channelIds.has(channelId))
    ) {
      return false;
    }

    return true;
  }

  private async sendToWorker(event: GatewayInternalEvent): Promise<void> {
    // This is the only network hop for forwarded Discord events. Keep the
    // request small, authenticated, and bounded by a timeout.
    const controller = new AbortController();
    // Gateway events are best-effort notifications. A short timeout prevents a
    // slow Worker/network path from backing up discord.js event handling.
    const timeoutId = setTimeout(() => controller.abort(), 5_000);

    try {
      const body = JSON.stringify(event);
      const workerUrl = new URL(this.config.workerInternalEventUrl);
      const response = await fetch(this.config.workerInternalEventUrl, {
        body,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          ...createSignedWorkerHeaders({
            body,
            method: 'POST',
            path: `${workerUrl.pathname}${workerUrl.search}`,
            secret: this.config.workerSecret,
          }),
        },
        method: 'POST',
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text();

        this.logger.warn('Worker rejected gateway event.', {
          channelId: event.channelId,
          emoji: readEmojiName(event.payload),
          eventType: event.eventType,
          guildId: event.guildId,
          messageId: event.messageId,
          responseBody: responseBody.slice(0, 300),
          status: response.status,
          userId: event.userId,
        });
        return;
      }

      this.logger.info('Forwarded gateway event to Worker.', {
        channelId: event.channelId,
        emoji: readEmojiName(event.payload),
        eventType: event.eventType,
        guildId: event.guildId,
        messageId: event.messageId,
        userId: event.userId,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function sanitizeGatewayPayload(
  eventType: GatewayEventType,
  payload: Record<string, unknown>,
  config: GatewayConfig,
): Record<string, unknown> {
  // Keep only fields the Worker can act on today. Raw discord.js objects can be
  // large and may contain data this bot should not persist or forward.
  if (REACTION_EVENTS.has(eventType)) {
    return compactRecord({
      channel_id: readString(payload, 'channel_id'),
      emoji: readEmoji(payload),
      guild_id: readString(payload, 'guild_id'),
      message_id: readString(payload, 'message_id'),
      user_id: readString(payload, 'user_id'),
    });
  }

  if (eventType === 'MESSAGE_DELETE') {
    return compactRecord({
      channel_id: readString(payload, 'channel_id'),
      guild_id: readString(payload, 'guild_id'),
      id: readString(payload, 'id'),
    });
  }

  if (eventType === 'MESSAGE_CREATE' || eventType === 'MESSAGE_UPDATE') {
    return compactRecord({
      author: readAuthor(payload),
      channel_id: readString(payload, 'channel_id'),
      content: config.forwardMessageContent
        ? readString(payload, 'content')
        : undefined,
      edited_timestamp: readString(payload, 'edited_timestamp'),
      guild_id: readString(payload, 'guild_id'),
      id: readString(payload, 'id'),
      timestamp: readString(payload, 'timestamp'),
      type: readNumber(payload, 'type'),
    });
  }

  return compactRecord({
    guild_id: readString(payload, 'guild_id'),
    joined_at: readString(payload, 'joined_at'),
    roles: readStringArray(payload, 'roles'),
    user: readUser(payload),
  });
}

function isGatewayEventType(
  eventType: string | undefined,
): eventType is GatewayEventType {
  // Runtime guard for the shared event union. Discord can emit far more events
  // than this gateway chooses to forward.
  return (
    eventType === 'GUILD_MEMBER_ADD' ||
    eventType === 'GUILD_MEMBER_REMOVE' ||
    eventType === 'GUILD_MEMBER_UPDATE' ||
    eventType === 'MESSAGE_CREATE' ||
    eventType === 'MESSAGE_DELETE' ||
    eventType === 'MESSAGE_REACTION_ADD' ||
    eventType === 'MESSAGE_REACTION_REMOVE' ||
    eventType === 'MESSAGE_REACTION_REMOVE_ALL' ||
    eventType === 'MESSAGE_REACTION_REMOVE_EMOJI' ||
    eventType === 'MESSAGE_UPDATE'
  );
}

function isBotEvent(
  payload: Record<string, unknown>,
  botUserId: string | undefined,
): boolean {
  // discord.js marks many bot users directly, but compare against our own ID as
  // a fallback for partial payloads where the bot flag is unavailable.
  const author = readRecord(payload, 'author');
  const user = readRecord(payload, 'user');
  const authorId = readString(author, 'id');
  const userId = readString(payload, 'user_id') ?? readString(user, 'id');

  return (
    readBoolean(author, 'bot') === true ||
    readBoolean(user, 'bot') === true ||
    (Boolean(botUserId) && (authorId === botUserId || userId === botUserId))
  );
}

function readEmoji(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // Reactions can use unicode or custom emoji. Preserve the stable fields the
  // Worker might need without forwarding the whole discord.js object.
  const emoji = readRecord(payload, 'emoji');

  if (!emoji) {
    return undefined;
  }

  return compactRecord({
    animated: readBoolean(emoji, 'animated'),
    id: readString(emoji, 'id'),
    name: readString(emoji, 'name'),
  });
}

function readEmojiName(payload: Record<string, unknown>): string | undefined {
  // Logging only needs the visible emoji/name, not the full payload.
  const emoji = readRecord(payload, 'emoji');
  return emoji ? readString(emoji, 'name') : undefined;
}

function readAuthor(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // The Worker currently only needs author identity and whether the author is a
  // bot. Leave usernames/display names out unless a workflow actually needs it.
  const author = readRecord(payload, 'author');

  if (!author) {
    return undefined;
  }

  return compactRecord({
    bot: readBoolean(author, 'bot'),
    id: readString(author, 'id'),
  });
}

function readUser(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // Member/reaction payloads use user instead of author, but the safe subset is
  // the same: id plus bot flag.
  const user = readRecord(payload, 'user');

  if (!user) {
    return undefined;
  }

  return compactRecord({
    bot: readBoolean(user, 'bot'),
    id: readString(user, 'id'),
  });
}

function readNestedString(
  payload: Record<string, unknown>,
  key: string,
  nestedKey: string,
): string | undefined {
  // Helper for promoted IDs in forward(), where Discord may put the user ID in
  // either a flat field or a nested author/user object.
  const record = readRecord(payload, key);
  return record ? readString(record, nestedKey) : undefined;
}

function readRecord(
  payload: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  // Payload fields are untrusted at this boundary, so each nested read gets a
  // tiny guard instead of a cast.
  const value = payload?.[key];
  return isRecord(value) ? value : undefined;
}

function readString(
  payload: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  // Empty strings do not carry useful Discord IDs, so treat them like missing
  // fields.
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(
  payload: Record<string, unknown>,
  key: string,
): string[] | undefined {
  // Role IDs should be all strings. If Discord gives mixed data, keep the valid
  // entries and let an empty result become "not present."
  const value = payload[key];

  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter(
    (item): item is string => typeof item === 'string',
  );
  return strings.length > 0 ? strings : undefined;
}

function readNumber(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  // Keep numeric event fields as numbers so the Worker contract stays close to
  // Discord's original shape.
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

function readBoolean(
  payload: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  // Boolean fields should stay booleans; strings like "false" are ignored here
  // because this is Discord payload data, not env parsing.
  const value = payload?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function compactRecord(
  record: Record<string, unknown | undefined>,
): Record<string, unknown> {
  // Avoid sending keys with undefined values; the Worker treats absence as "not
  // available" and validates only the fields each event type requires.
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, unknown] => {
      const [, value] = entry;
      return value !== undefined;
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays count as objects in JavaScript, but they are not useful as keyed
  // payload records for this code path.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
