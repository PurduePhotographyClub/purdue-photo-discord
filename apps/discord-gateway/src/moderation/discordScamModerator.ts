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
  buildScamModerationAlertPayload,
  type ScamReviewAction,
} from './scamModerationAlert.js';
import {
  createScamModerationService,
  type ScamGatewayMessageEventType,
  type ScamMessageContext,
  type ScamModerationActions,
  type ScamModerationAlert,
} from './scamModerationService.js';
import type {
  DiscordScamReviewRequest,
  DiscordScamReviewResult,
  PendingScamReview,
} from './scamReviewTypes.js';
import {
  prunePendingReviews,
  registerPendingReview,
  updatePendingReviewState,
} from './scamReviewStore.js';
import {
  isProtectedScamMember,
  isScamReviewActionAllowed,
  isScamReviewModerator,
} from './scamReviewPolicy.js';

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
  review(input: DiscordScamReviewRequest): Promise<DiscordScamReviewResult>;
}

const ROLE_SAFETY_CACHE_MS = 5 * 60 * 1_000;
const PUBLIC_ANNOUNCEMENT_COPY = '🚨 Likely scam removed. Nice try. 🤡';

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
  let pendingReviews: ReadonlyMap<string, PendingScamReview> = new Map();

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
      if (
        !preliminaryAnalysis.isLikelyScam &&
        !preliminaryAnalysis.requiresReview
      ) {
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
        registerPendingReview: (alert, alertMessageId) => {
          pendingReviews = registerPendingReview(
            pendingReviews,
            alert,
            alertMessageId,
            Date.now(),
          );
        },
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

    async review(input) {
      if (!config.enabled || !ready || !client) {
        return reviewResult(
          false,
          'unavailable',
          'Scam review is temporarily unavailable.',
        );
      }

      pendingReviews = prunePendingReviews(pendingReviews, Date.now());
      const pending = pendingReviews.get(input.reviewId);
      if (!pending || pending.alertMessageId !== input.alertMessageId) {
        return reviewResult(
          false,
          'expired',
          'This review expired or belongs to an older bot session.',
        );
      }
      if (pending.state !== 'pending') {
        return reviewResult(
          false,
          'already_resolved',
          'This review is already being handled or has been resolved.',
        );
      }

      const guild = await client.guilds.fetch(config.guildId);
      const actor = await guild.members.fetch(input.actorId).catch(() => null);
      if (!actor || !isScamReviewModerator(actor)) {
        return reviewResult(
          false,
          'forbidden',
          'Only Discord Admin or Executive members can resolve scam reviews.',
        );
      }

      if (!isScamReviewActionAllowed(pending.alert, input.action)) {
        return reviewResult(
          false,
          'forbidden',
          'That action is not allowed for this review.',
        );
      }

      const claimableReview = pendingReviews.get(input.reviewId);
      if (
        !claimableReview ||
        claimableReview.alertMessageId !== input.alertMessageId ||
        claimableReview.state !== 'pending'
      ) {
        return reviewResult(
          false,
          'already_resolved',
          'This review is already being handled or has been resolved.',
        );
      }

      pendingReviews = updatePendingReviewState(
        pendingReviews,
        input.reviewId,
        'processing',
      );

      if (input.action === 'dismiss' || input.action === 'reviewed') {
        const status = input.action === 'dismiss' ? 'dismissed' : 'reviewed';
        const message =
          input.action === 'dismiss'
            ? 'Dismissed. No message or role action was taken.'
            : 'Marked reviewed. No action was taken against the reporter.';
        pendingReviews = updatePendingReviewState(
          pendingReviews,
          input.reviewId,
          status,
        );
        await editReviewAlert(
          client,
          config,
          claimableReview,
          input.action,
          input.actorId,
          message,
          logger,
        );
        return reviewResult(true, status, message);
      }

      let outcome: Awaited<ReturnType<typeof confirmPendingReview>>;
      try {
        outcome = await confirmPendingReview({
          client,
          config,
          guild,
          logger,
          pending: claimableReview,
        });
      } catch (error) {
        pendingReviews = updatePendingReviewState(
          pendingReviews,
          input.reviewId,
          'pending',
        );
        logger.warn(
          'Could not resolve a scam review; the action can be retried.',
          {
            error,
            messageId: claimableReview.alert.messageId,
            reviewId: input.reviewId,
          },
        );
        return reviewResult(
          false,
          'unavailable',
          'Discord could not complete that review. Try again in a moment.',
        );
      }
      pendingReviews = updatePendingReviewState(
        pendingReviews,
        input.reviewId,
        outcome.status,
      );
      await editReviewAlert(
        client,
        config,
        claimableReview,
        outcome.status === 'confirmed' ? 'confirm' : 'stale',
        input.actorId,
        outcome.message,
        logger,
      );
      return outcome;
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
    protectedMember: isProtectedScamMember(member, config),
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
  registerPendingReview: (
    alert: ScamModerationAlert,
    alertMessageId: string,
  ) => void;
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

        const sentAlert = await alertChannel.send(
          buildScamModerationAlertPayload(alert),
        );
        if (alert.reviewOnly) {
          input.registerPendingReview(alert, sentAlert.id);
        }
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

async function confirmPendingReview(input: {
  client: Client;
  config: GatewayScamModerationConfig;
  guild: Guild;
  logger: Logger;
  pending: PendingScamReview;
}): Promise<
  Omit<DiscordScamReviewResult, 'status'> & {
    status: 'confirmed' | 'message_changed';
  }
> {
  const { alert } = input.pending;
  const sourceChannel = await input.client.channels.fetch(alert.channelId);
  if (!sourceChannel?.isTextBased()) {
    return reviewResult(
      false,
      'message_changed',
      'The original channel is unavailable. No action was taken.',
    );
  }

  const sourceMessage = await sourceChannel.messages
    .fetch(alert.messageId)
    .catch(() => null);
  if (!sourceMessage || sourceMessage.author.id !== alert.userId) {
    return reviewResult(
      false,
      'message_changed',
      'The original message is gone or no longer matches this review. No role action was taken.',
    );
  }

  if (sourceMessage.content !== alert.content) {
    return reviewResult(
      false,
      'message_changed',
      'The message changed after this review was created. No action was taken.',
    );
  }

  const currentAnalysis = analyzeScamMessage({
    accountCreatedTimestamp: sourceMessage.author.createdTimestamp,
    content: sourceMessage.content,
    joinedTimestamp: sourceMessage.member?.joinedTimestamp ?? null,
    mentionsEveryone: sourceMessage.mentions.everyone,
    observedAtTimestamp: Date.now(),
  });
  if (!currentAnalysis.isLikelyScam && !currentAnalysis.requiresReview) {
    return reviewResult(
      false,
      'message_changed',
      'The message changed and no longer matches the scam detector. No action was taken.',
    );
  }

  const sourceMember = await input.guild.members
    .fetch(alert.userId)
    .catch(() => null);
  if (!sourceMember || isProtectedScamMember(sourceMember, input.config)) {
    return reviewResult(
      false,
      'message_changed',
      'The member is unavailable or protected. No action was taken.',
    );
  }

  try {
    await sourceMessage.delete();
  } catch (error) {
    input.logger.warn('Could not delete a moderator-confirmed scam message.', {
      channelId: alert.channelId,
      error,
      messageId: alert.messageId,
    });
    return reviewResult(
      false,
      'message_changed',
      'Discord could not delete the original message. No role action was taken.',
    );
  }

  let failedActions: string[] = [];
  let roleConfigurationSafe = true;
  try {
    await assertModerationConfigurationSafe(input.guild, input.config);
  } catch (error) {
    roleConfigurationSafe = false;
    failedActions = [...failedActions, 'role safety check'];
    input.logger.warn('Could not validate roles for a confirmed scam.', {
      error,
      guildId: alert.guildId,
      userId: alert.userId,
    });
  }

  if (
    roleConfigurationSafe &&
    !sourceMember.roles.cache.has(input.config.restrictedRoleId)
  ) {
    try {
      await sourceMember.roles.add(
        input.config.restrictedRoleId,
        'Moderator confirmed probable scam',
      );
    } catch (error) {
      failedActions = [...failedActions, 'Clown role'];
      input.logger.warn('Could not add Clown after a confirmed scam.', {
        error,
        guildId: alert.guildId,
        userId: alert.userId,
      });
    }
  }

  if (
    roleConfigurationSafe &&
    sourceMember.roles.cache.has(input.config.verifiedRoleId)
  ) {
    try {
      await sourceMember.roles.remove(
        input.config.verifiedRoleId,
        'Moderator confirmed probable scam',
      );
    } catch (error) {
      failedActions = [...failedActions, 'verified role'];
      input.logger.warn('Could not remove verified after a confirmed scam.', {
        error,
        guildId: alert.guildId,
        userId: alert.userId,
      });
    }
  }

  try {
    if (!sourceChannel.isSendable()) {
      throw new Error('The source channel is not sendable.');
    }
    await sourceChannel.send({
      allowedMentions: { parse: [] },
      content: PUBLIC_ANNOUNCEMENT_COPY,
    });
  } catch (error) {
    failedActions = [...failedActions, 'channel notice'];
    input.logger.warn('Could not announce a moderator-confirmed scam.', {
      channelId: alert.channelId,
      error,
      messageId: alert.messageId,
    });
  }

  const message = failedActions.length
    ? `Message deleted. Follow up on: ${failedActions.join(', ')}.`
    : 'Message deleted; verified removed when present; Clown added.';
  return reviewResult(true, 'confirmed', message);
}

async function editReviewAlert(
  client: Client,
  config: GatewayScamModerationConfig,
  pending: PendingScamReview,
  action: ScamReviewAction | 'stale',
  actorId: string,
  result: string,
  logger: Logger,
) {
  try {
    const alertChannel = config.alertChannelId
      ? await client.channels.fetch(config.alertChannelId)
      : null;
    if (!alertChannel?.isTextBased()) {
      throw new Error('The scam alert channel is unavailable.');
    }
    const alertMessage = await alertChannel.messages.fetch(
      pending.alertMessageId,
    );
    await alertMessage.edit(
      buildScamModerationAlertPayload(pending.alert, {
        action,
        moderatorId: actorId,
        result,
      }),
    );
  } catch (error) {
    logger.warn('Could not update the resolved scam review alert.', {
      alertMessageId: pending.alertMessageId,
      error,
      messageId: pending.alert.messageId,
    });
  }
}

function reviewResult<TStatus extends DiscordScamReviewResult['status']>(
  ok: boolean,
  status: TStatus,
  message: string,
): Omit<DiscordScamReviewResult, 'status'> & { status: TStatus } {
  return { message, ok, status };
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
