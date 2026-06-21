/**
 * The long-running Discord client.
 *
 * Cloudflare Workers cannot keep a Gateway websocket open, so the VPS owns that
 * connection. This file keeps the bot online, forwards selected events, and lets
 * the local HTTP API update presence without restarting the process.
 */
import {
  Client,
  Events,
  type ClientUser,
  type GuildMember,
  type Message,
  type MessageReaction,
  type PartialGuildMember,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import type { GatewayConfig, GatewayPresenceStatus } from '../config.js';
import type { WorkerEventForwarder } from './forwarder.js';
import type { Logger } from '../utils/logger.js';

export interface DiscordGatewayRunner {
  getHealth(): DiscordGatewayHealthSnapshot;
  start(): Promise<void>;
  stop(): void;
  updatePresence(
    update: DiscordGatewayPresenceUpdate,
  ): DiscordGatewayPresenceSnapshot;
}

export type DiscordGatewayConnectionStatus = 'ready' | 'starting' | 'stopped';

export interface DiscordGatewayHealthSnapshot {
  ok: boolean;
  service: 'pccbot-discord-gateway';
  status: DiscordGatewayConnectionStatus;
  uptimeSeconds: number;
  discordWebSocketStatus: number;
  botUserId?: string;
  readyAt?: string;
  stoppedAt?: string;
  lastDisconnectAt?: string;
  lastError?: string;
  lastWarning?: string;
  username?: string;
  forwarding: {
    botEvents: boolean;
    members: boolean;
    messageContent: boolean;
    messages: boolean;
    reactions: boolean;
  };
  presence: DiscordGatewayPresenceSnapshot;
}

export interface DiscordGatewayPresenceUpdate {
  activityName?: string | null;
  activityType?: number;
  status?: GatewayPresenceStatus;
}

export interface DiscordGatewayPresenceSnapshot {
  activityName?: string;
  activityType?: number;
  ok: true;
  status: GatewayPresenceStatus;
  updatedAt: string;
}

export function createDiscordGatewayRunner(
  config: GatewayConfig,
  forwarder: WorkerEventForwarder,
  logger: Logger,
): DiscordGatewayRunner {
  // The runner keeps all mutable Discord state inside this closure. That makes
  // the HTTP server a thin caller instead of another owner of client state.
  const startedAt = Date.now();
  let status: DiscordGatewayConnectionStatus = 'starting';
  let botUserId: string | undefined;
  let lastDisconnectAt: string | undefined;
  let lastError: string | undefined;
  let lastWarning: string | undefined;
  let readyAt: string | undefined;
  let stoppedAt: string | undefined;
  let username: string | undefined;
  // Presence can change after boot through /presence. Store the desired state
  // here instead of asking discord.js to be the source of truth.
  let presenceActivityName = config.activityName;
  let presenceActivityType = config.activityType;
  let presenceStatus = config.status;
  let presenceUpdatedAt = new Date().toISOString();

  const client = new Client({
    intents: config.intents,
    partials: config.partials,
  });

  client.once(Events.ClientReady, (readyClient) => {
    status = 'ready';
    readyAt = new Date().toISOString();
    botUserId = readyClient.user.id;
    username = readyClient.user.tag;

    logger.info('Discord Gateway client is ready.', {
      botUserId,
      intents: config.intents,
      partials: config.partials,
      username,
    });

    applyPresence(readyClient.user);
  });

  client.on(Events.Error, (error) => {
    lastError = getErrorMessage(error);
    logger.error('Discord Gateway client error.', error);
  });

  client.on(Events.Warn, (message) => {
    lastWarning = message;
    logger.warn('Discord Gateway client warning.', { message });
  });

  client.on(Events.ShardDisconnect, () => {
    if (status !== 'stopped') {
      status = 'starting';
      lastDisconnectAt = new Date().toISOString();
    }
  });

  client.on(Events.ShardResume, () => {
    if (status !== 'stopped') {
      status = 'ready';
    }
  });

  if (config.forwardReactions) {
    // Each listener serializes the discord.js object immediately so the
    // forwarder receives a stable, JSON-safe payload.
    client.on(Events.MessageReactionAdd, (reaction, user) => {
      void forwardDiscordJsEvent(
        forwarder,
        'MESSAGE_REACTION_ADD',
        serializeReaction(reaction, user),
        client.user?.id,
        logger,
      );
    });

    client.on(Events.MessageReactionRemove, (reaction, user) => {
      void forwardDiscordJsEvent(
        forwarder,
        'MESSAGE_REACTION_REMOVE',
        serializeReaction(reaction, user),
        client.user?.id,
        logger,
      );
    });

    client.on(Events.MessageReactionRemoveAll, (message) => {
      void forwardDiscordJsEvent(
        forwarder,
        'MESSAGE_REACTION_REMOVE_ALL',
        serializeMessageReference(message),
        client.user?.id,
        logger,
      );
    });

    client.on(Events.MessageReactionRemoveEmoji, (reaction) => {
      void forwardDiscordJsEvent(
        forwarder,
        'MESSAGE_REACTION_REMOVE_EMOJI',
        serializeReaction(reaction),
        client.user?.id,
        logger,
      );
    });
  }

  if (config.forwardMessages) {
    // Message content is stripped later unless FORWARD_MESSAGE_CONTENT is true,
    // allowing message lifecycle events without requiring content storage.
    client.on(Events.MessageCreate, (message) => {
      void forwardDiscordJsEvent(
        forwarder,
        'MESSAGE_CREATE',
        serializeMessage(message, config),
        client.user?.id,
        logger,
      );
    });

    client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
      void forwardDiscordJsEvent(
        forwarder,
        'MESSAGE_UPDATE',
        serializeMessage(newMessage, config),
        client.user?.id,
        logger,
      );
    });

    client.on(Events.MessageDelete, (message) => {
      void forwardDiscordJsEvent(
        forwarder,
        'MESSAGE_DELETE',
        serializeMessageReference(message),
        client.user?.id,
        logger,
      );
    });
  }

  if (config.forwardMembers) {
    client.on(Events.GuildMemberAdd, (member) => {
      void forwardDiscordJsEvent(
        forwarder,
        'GUILD_MEMBER_ADD',
        serializeMember(member),
        client.user?.id,
        logger,
      );
    });

    client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => {
      void forwardDiscordJsEvent(
        forwarder,
        'GUILD_MEMBER_UPDATE',
        serializeMember(newMember),
        client.user?.id,
        logger,
      );
    });

    client.on(Events.GuildMemberRemove, (member) => {
      void forwardDiscordJsEvent(
        forwarder,
        'GUILD_MEMBER_REMOVE',
        serializeMember(member),
        client.user?.id,
        logger,
      );
    });
  }

  return {
    getHealth() {
      // Return a snapshot, not live references, so /health can serialize it
      // safely at any moment during reconnects or shutdown.
      const snapshot: DiscordGatewayHealthSnapshot = {
        discordWebSocketStatus: client.ws.status,
        forwarding: {
          botEvents: config.forwardBotEvents,
          members: config.forwardMembers,
          messageContent: config.forwardMessageContent,
          messages: config.forwardMessages,
          reactions: config.forwardReactions,
        },
        ok: status === 'ready',
        presence: getPresenceSnapshot(),
        service: 'pccbot-discord-gateway',
        status,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
      };

      if (botUserId) {
        snapshot.botUserId = botUserId;
      }

      if (lastDisconnectAt) {
        snapshot.lastDisconnectAt = lastDisconnectAt;
      }

      if (lastError) {
        snapshot.lastError = lastError;
      }

      if (lastWarning) {
        snapshot.lastWarning = lastWarning;
      }

      if (readyAt) {
        snapshot.readyAt = readyAt;
      }

      if (stoppedAt) {
        snapshot.stoppedAt = stoppedAt;
      }

      if (username) {
        snapshot.username = username;
      }

      return snapshot;
    },
    async start() {
      // discord.js handles reconnects after login; this call starts the first
      // websocket connection and resolves once authentication succeeds.
      await client.login(config.discordToken);
    },
    stop() {
      // Mark stopped before destroying the client so disconnect events during
      // shutdown do not make health look like a reconnect attempt.
      status = 'stopped';
      stoppedAt = new Date().toISOString();
      client.destroy();
    },
    updatePresence(update) {
      // /status sends partial updates. Missing fields mean "leave as-is";
      // activityName: null means "clear the activity".
      if (update.status) {
        presenceStatus = update.status;
      }

      if ('activityName' in update) {
        presenceActivityName =
          update.activityName === null
            ? undefined
            : update.activityName?.trim();
      }

      if (update.activityType !== undefined) {
        presenceActivityType = update.activityType;
      }

      presenceUpdatedAt = new Date().toISOString();

      if (!client.user) {
        throw new Error('Discord Gateway client is not ready.');
      }

      applyPresence(client.user);
      logger.info('Updated Discord Gateway presence.', getPresenceSnapshot());

      return getPresenceSnapshot();
    },
  };

  function applyPresence(user: ClientUser): void {
    // Discord wants an empty activities array when the bot should show no
    // activity text.
    user.setPresence({
      activities: presenceActivityName
        ? [
            {
              name: presenceActivityName,
              type: presenceActivityType,
            },
          ]
        : [],
      status: presenceStatus,
    });
  }

  function getPresenceSnapshot(): DiscordGatewayPresenceSnapshot {
    // Health and /presence responses share this shape so the Worker can show
    // current state without knowing discord.js internals.
    const snapshot: DiscordGatewayPresenceSnapshot = {
      ok: true,
      status: presenceStatus,
      updatedAt: presenceUpdatedAt,
    };

    if (presenceActivityName) {
      snapshot.activityName = presenceActivityName;
      snapshot.activityType = presenceActivityType;
    }

    return snapshot;
  }
}

async function forwardDiscordJsEvent(
  forwarder: WorkerEventForwarder,
  eventType: string,
  payload: Record<string, unknown>,
  botUserId: string | undefined,
  logger: Logger,
): Promise<void> {
  // Bridge callback-style Discord events into the async forwarder.
  try {
    await forwarder.forward(eventType, payload, botUserId);
  } catch (error) {
    // Event handlers cannot return failures to Discord, so keep the client alive
    // and rely on logs for delivery issues.
    logger.error('Failed to forward Discord Gateway event.', error);
  }
}

function serializeReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user?: User | PartialUser,
): Record<string, unknown> {
  // Serialize only stable IDs and emoji details. Partial reactions can be sparse
  // after a gateway reconnect, so every optional field is guarded.
  return compactRecord({
    channel_id: reaction.message.channelId,
    emoji: compactRecord({
      animated: reaction.emoji.animated ?? undefined,
      id: reaction.emoji.id ?? undefined,
      name: reaction.emoji.name ?? undefined,
    }),
    guild_id: reaction.message.guildId ?? undefined,
    message_id: reaction.message.id,
    user: user
      ? compactRecord({
          bot: user.bot,
          id: user.id,
        })
      : undefined,
    user_id: user?.id,
  });
}

function serializeMessage(
  message: Message | PartialMessage,
  config: GatewayConfig,
): Record<string, unknown> {
  // Message content is opt-in because it requires the privileged Discord intent
  // and is not needed for every workflow.
  return compactRecord({
    author: message.author
      ? compactRecord({
          bot: message.author.bot,
          id: message.author.id,
        })
      : undefined,
    channel_id: message.channelId,
    content: config.forwardMessageContent ? message.content : undefined,
    edited_timestamp: message.editedAt?.toISOString(),
    guild_id: message.guildId ?? undefined,
    id: message.id,
    timestamp: message.createdAt?.toISOString(),
    type: message.type,
  });
}

function serializeMessageReference(
  message: Message | PartialMessage,
): Record<string, unknown> {
  // Delete and remove-all events only need enough message context for the Worker
  // to route or log the event.
  return compactRecord({
    channel_id: message.channelId,
    guild_id: message.guildId ?? undefined,
    id: message.id,
  });
}

function serializeMember(
  member: GuildMember | PartialGuildMember,
): Record<string, unknown> {
  // Member payloads can be partial, but guild/user IDs are still enough for most
  // admin workflows.
  return compactRecord({
    guild_id: member.guild.id,
    joined_at: member.joinedAt?.toISOString(),
    roles: 'cache' in member.roles ? [...member.roles.cache.keys()] : undefined,
    user: compactRecord({
      bot: member.user.bot,
      id: member.user.id,
    }),
  });
}

function compactRecord(
  record: Record<string, unknown | undefined>,
): Record<string, unknown> {
  // JSON payloads stay small and explicit by omitting fields unavailable on
  // partial Discord objects.
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, unknown] => {
      const [, value] = entry;
      return value !== undefined;
    }),
  );
}

function getErrorMessage(error: unknown): string {
  // Normalize thrown values before storing them in health output.
  return error instanceof Error ? error.message : String(error);
}
