import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type PartialMessage,
} from 'discord.js';
import type { GatewayScamModerationConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { analyzeScamMessage } from './scamDetectionPolicy.js';
import {
  createScamModerationService,
  type ScamGatewayMessageEventType,
  type ScamMessageContext,
  type ScamModerationActions,
  type ScamModerationAlert,
} from './scamModerationService.js';

export interface DiscordScamModerationHealth {
  enabled: boolean;
  handledCount: number;
  lastFailure?: string;
  lastHandledAt?: string;
  ready: boolean;
}

export interface DiscordScamModerator {
  getHealth(): DiscordScamModerationHealth;
  handle(
    message: Message | PartialMessage,
    eventType: ScamGatewayMessageEventType,
  ): Promise<void>;
  initialize(client: Client): Promise<void>;
}

const ROLE_SAFETY_CACHE_MS = 5 * 60 * 1_000;
const PROTECTED_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ModerateMembers,
] as const;

export function createDiscordScamModerator(
  config: GatewayScamModerationConfig,
  logger: Logger,
): DiscordScamModerator {
  const service = createScamModerationService(config);
  let client: Client | undefined;
  let ready = false;
  let handledCount = 0;
  let lastFailure: string | undefined;
  let lastHandledAt: string | undefined;
  let restrictedRoleValidatedAt = 0;

  return {
    getHealth() {
      return {
        enabled: config.enabled,
        handledCount,
        ...(lastFailure ? { lastFailure } : {}),
        ...(lastHandledAt ? { lastHandledAt } : {}),
        ready,
      };
    },

    async handle(message, eventType) {
      if (!config.enabled || !ready || !client) {
        return;
      }

      const resolvedMessage = await resolveMessage(message, logger);
      if (!resolvedMessage || !isInspectableMessage(resolvedMessage, config)) {
        return;
      }

      const preliminaryAnalysis = analyzeScamMessage({
        accountCreatedTimestamp: resolvedMessage.author.createdTimestamp,
        content: resolvedMessage.content,
        joinedTimestamp: resolvedMessage.member?.joinedTimestamp ?? null,
        mentionsEveryone: resolvedMessage.mentions.everyone,
        observedAtTimestamp: Date.now(),
      });
      if (!preliminaryAnalysis.isLikelyScam) {
        return;
      }

      const member = await resolveMember(resolvedMessage, logger);
      if (!member) {
        lastFailure = 'member_context_unavailable';
        return;
      }

      const context = createMessageContext(
        resolvedMessage,
        member,
        eventType,
        config,
      );
      const actions = createModerationActions({
        client,
        config,
        getRestrictedRoleValidatedAt: () => restrictedRoleValidatedAt,
        logger,
        member,
        message: resolvedMessage,
        setRestrictedRoleValidatedAt: (timestamp) => {
          restrictedRoleValidatedAt = timestamp;
        },
      });
      const result = await service.moderate(context, actions);

      if (!result.handled || result.duplicate) {
        return;
      }

      handledCount += 1;
      lastHandledAt = new Date().toISOString();
      lastFailure = result.failedActions.length
        ? result.failedActions.join(',')
        : undefined;
      logger.warn(
        result.protectedMember
          ? 'Probable scam pattern needs protected-member review.'
          : 'Probable scam message was handled.',
        {
          channelId: context.channelId,
          eventType,
          failedActions: result.failedActions,
          guildId: context.guildId,
          messageId: context.messageId,
          protectedMember: result.protectedMember,
          score: result.analysis?.score,
          signalIds: result.analysis?.signalIds,
          userId: context.userId,
        },
      );
    },

    async initialize(discordClient) {
      client = discordClient;
      if (!config.enabled) {
        return;
      }

      try {
        const guild = await discordClient.guilds.fetch(config.guildId);
        await assertModerationConfigurationSafe(guild, config);
        if (config.alertChannelId) {
          const alertChannel = await discordClient.channels.fetch(
            config.alertChannelId,
          );
          if (!alertChannel?.isSendable()) {
            throw new Error('The scam alert channel is not sendable.');
          }
        }

        restrictedRoleValidatedAt = Date.now();
        lastFailure = undefined;
        ready = true;
        logger.info('Scam moderation is ready.', {
          alertingEnabled: Boolean(config.alertChannelId),
          excludedChannelCount: config.excludedChannelIds.size,
          guildId: config.guildId,
        });
      } catch (error) {
        ready = false;
        lastFailure = getErrorMessage(error);
        logger.error('Scam moderation failed its startup checks.', error);
      }
    },
  };
}

async function resolveMessage(
  message: Message | PartialMessage,
  logger: Logger,
): Promise<Message | undefined> {
  if (!message.partial) {
    return message;
  }

  try {
    return await message.fetch();
  } catch (error) {
    logger.warn('Could not fetch a partial message for scam inspection.', {
      channelId: message.channelId,
      error,
      guildId: message.guildId ?? undefined,
      messageId: message.id,
    });
    return undefined;
  }
}

function isInspectableMessage(
  message: Message,
  config: GatewayScamModerationConfig,
) {
  return (
    message.guildId === config.guildId &&
    message.content.trim().length > 0 &&
    !message.author.bot &&
    !message.system &&
    !message.webhookId &&
    !config.excludedChannelIds.has(message.channelId)
  );
}

async function resolveMember(message: Message, logger: Logger) {
  if (message.member) {
    return message.member;
  }

  try {
    return await message.guild?.members.fetch(message.author.id);
  } catch (error) {
    logger.warn('Could not resolve the member for scam moderation.', {
      error,
      guildId: message.guildId ?? undefined,
      messageId: message.id,
      userId: message.author.id,
    });
    return undefined;
  }
}

function createMessageContext(
  message: Message,
  member: GuildMember,
  eventType: ScamGatewayMessageEventType,
  config: GatewayScamModerationConfig,
): ScamMessageContext {
  const roleIds = [...member.roles.cache.keys()];

  return {
    accountCreatedTimestamp: message.author.createdTimestamp,
    authorBot: message.author.bot,
    channelId: message.channelId,
    content: message.content,
    eventType,
    guildId: message.guildId,
    joinedTimestamp: member.joinedTimestamp,
    mentionsEveryone: message.mentions.everyone,
    messageId: message.id,
    observedAtTimestamp: Date.now(),
    protectedMember:
      roleIds.some((roleId) => config.protectedRoleIds.has(roleId)) ||
      PROTECTED_PERMISSIONS.some((permission) =>
        member.permissions.has(permission),
      ),
    roleIds,
    system: message.system,
    userId: message.author.id,
    webhookId: message.webhookId,
  };
}

function createModerationActions(input: {
  client: Client;
  config: GatewayScamModerationConfig;
  getRestrictedRoleValidatedAt: () => number;
  logger: Logger;
  member: GuildMember;
  message: Message;
  setRestrictedRoleValidatedAt: (timestamp: number) => void;
}): ScamModerationActions {
  const { client, config, logger, member, message } = input;

  return {
    async addRestrictedRole(_guildId, _userId, roleId) {
      try {
        if (
          Date.now() - input.getRestrictedRoleValidatedAt() >=
          ROLE_SAFETY_CACHE_MS
        ) {
          await assertModerationConfigurationSafe(message.guild!, config);
          input.setRestrictedRoleValidatedAt(Date.now());
        }
        await member.roles.add(
          roleId,
          'Probable high-confidence giveaway scam',
        );
      } catch (error) {
        logger.warn('Could not add the scam-restricted role.', {
          error,
          guildId: message.guildId ?? undefined,
          roleId,
          userId: member.id,
        });
        throw error;
      }
    },

    async deleteMessage(channelId, messageId) {
      try {
        await message.delete();
      } catch (error) {
        if (isUnknownMessageError(error)) {
          logger.info('Scam message was already deleted.', {
            channelId,
            messageId,
          });
          return;
        }

        logger.warn('Could not delete a probable scam message.', {
          channelId,
          error,
          messageId,
        });
        throw error;
      }
    },

    async removeVerifiedRole(_guildId, _userId, roleId) {
      try {
        await member.roles.remove(
          roleId,
          'Probable high-confidence giveaway scam',
        );
      } catch (error) {
        logger.warn('Could not remove the verified role from a scam account.', {
          error,
          guildId: message.guildId ?? undefined,
          roleId,
          userId: member.id,
        });
        throw error;
      }
    },

    async sendPublicAnnouncement(channelId, content) {
      try {
        const sourceChannel = await client.channels.fetch(channelId);
        if (!sourceChannel?.isSendable()) {
          throw new Error('The source channel is not sendable.');
        }

        await sourceChannel.send({
          allowedMentions: { parse: [] },
          content,
        });
      } catch (error) {
        logger.warn('Could not send the public scam announcement.', {
          channelId,
          error,
          messageId: message.id,
        });
        throw error;
      }
    },

    async sendAlert(alertChannelId, alert) {
      try {
        const alertChannel = await client.channels.fetch(alertChannelId);
        if (!alertChannel?.isSendable()) {
          throw new Error('The scam alert channel is not sendable.');
        }

        await alertChannel.send({
          allowedMentions: { parse: [] },
          content: formatModerationAlert(alert),
        });
      } catch (error) {
        logger.warn('Could not send the scam moderation alert.', {
          alertChannelId,
          error,
          messageId: alert.messageId,
        });
        throw error;
      }
    },
  };
}

async function assertModerationConfigurationSafe(
  guild: Guild,
  config: GatewayScamModerationConfig,
) {
  const [restrictedRole, verifiedRole, botMember] = await Promise.all([
    guild.roles.fetch(config.restrictedRoleId),
    guild.roles.fetch(config.verifiedRoleId),
    guild.members.fetchMe(),
  ]);
  if (!restrictedRole || restrictedRole.managed) {
    throw new Error('The scam-restricted role is missing or managed.');
  }
  if (restrictedRole.permissions.bitfield !== 0n) {
    throw new Error('The scam-restricted role has guild permissions.');
  }
  if (!verifiedRole) {
    throw new Error('The verified role is missing.');
  }
  if (
    !botMember.permissions.has(PermissionFlagsBits.ManageMessages) ||
    !botMember.permissions.has(PermissionFlagsBits.ManageRoles)
  ) {
    throw new Error('The bot lacks required moderation permissions.');
  }
  if (
    botMember.roles.highest.position <= restrictedRole.position ||
    botMember.roles.highest.position <= verifiedRole.position
  ) {
    throw new Error('The bot role is below a managed moderation role.');
  }
}

function formatModerationAlert(alert: ScamModerationAlert) {
  const outcome =
    alert.protectedMember && alert.failedActions.includes('delete_message')
      ? 'Deletion failed; protected member roles unchanged; review required.'
      : alert.protectedMember
        ? 'Protected member: message deleted; roles unchanged pending review.'
        : alert.failedActions.length > 0
          ? `Partial action: ${alert.failedActions.join(', ')} needs review.`
          : 'Message deleted; verified removed when present; Clown added.';

  return [
    '**Probable giveaway scam detected**',
    `User ID: ${alert.userId}`,
    `Channel ID: ${alert.channelId}`,
    `Message ID: ${alert.messageId}`,
    `Event: ${alert.eventType}`,
    `Score: ${alert.score}`,
    `Signals: ${alert.signalIds.join(', ')}`,
    `Result: ${outcome}`,
  ].join('\n');
}

function isUnknownMessageError(error: unknown) {
  if (!isRecord(error)) {
    return false;
  }

  return error.code === 10_008;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
