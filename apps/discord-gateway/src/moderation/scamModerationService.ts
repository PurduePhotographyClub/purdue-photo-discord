import {
  analyzeScamMessage,
  type ScamDetectionResult,
  type ScamSignalId,
} from './scamDetectionPolicy.js';

export type ScamGatewayMessageEventType = 'MESSAGE_CREATE' | 'MESSAGE_UPDATE';

export interface ScamMessageContext {
  accountCreatedTimestamp: number | null;
  authorBot: boolean;
  channelId: string;
  content: string;
  eventType: ScamGatewayMessageEventType;
  guildId: string | null;
  joinedTimestamp: number | null;
  mentionsEveryone: boolean;
  messageId: string;
  observedAtTimestamp: number;
  protectedMember: boolean;
  roleIds: readonly string[];
  system: boolean;
  userId: string;
  webhookId: string | null;
}

export interface ScamModerationConfig {
  alertChannelId: string | null;
  enabled: boolean;
  excludedChannelIds: ReadonlySet<string>;
  guildId: string;
  restrictedRoleId: string;
  verifiedRoleId: string;
}

export type ScamModerationActionId =
  | 'add_restricted_role'
  | 'delete_message'
  | 'remove_verified_role'
  | 'send_public_announcement'
  | 'send_alert';

export interface ScamModerationAlert {
  channelId: string;
  eventType: ScamGatewayMessageEventType;
  failedActions: readonly ScamModerationActionId[];
  guildId: string;
  messageId: string;
  protectedMember: boolean;
  score: number;
  signalIds: readonly ScamSignalId[];
  userId: string;
}

export interface ScamModerationActions {
  addRestrictedRole: (
    guildId: string,
    userId: string,
    roleId: string,
  ) => Promise<void>;
  deleteMessage: (channelId: string, messageId: string) => Promise<void>;
  removeVerifiedRole: (
    guildId: string,
    userId: string,
    roleId: string,
  ) => Promise<void>;
  sendPublicAnnouncement: (channelId: string, content: string) => Promise<void>;
  sendAlert: (
    alertChannelId: string,
    alert: ScamModerationAlert,
  ) => Promise<void>;
}

export interface ScamModerationResult {
  analysis: ScamDetectionResult | null;
  duplicate: boolean;
  failedActions: ScamModerationActionId[];
  handled: boolean;
  protectedMember: boolean;
}

export interface ScamModerationService {
  moderate(
    message: ScamMessageContext,
    actions: ScamModerationActions,
  ): Promise<ScamModerationResult>;
}

const DEDUPLICATION_TTL_MS = 10 * 60 * 1_000;
const ANNOUNCEMENT_COOLDOWN_MS = 30 * 1_000;
const MAX_DEDUPLICATION_ENTRIES = 2_000;
const MAX_ANNOUNCEMENT_CHANNEL_ENTRIES = 500;
const PUBLIC_ANNOUNCEMENT_COPY = '🚨 Likely scam removed. Nice try. 🤡';

export function createScamModerationService(
  config: ScamModerationConfig,
): ScamModerationService {
  let recentMessageIds: ReadonlyMap<string, number> = new Map();
  let recentAnnouncementChannelIds: ReadonlyMap<string, number> = new Map();

  return {
    async moderate(message, actions) {
      if (!shouldInspectMessage(message, config)) {
        return ignoredResult();
      }

      const analysis = analyzeScamMessage({
        accountCreatedTimestamp: message.accountCreatedTimestamp,
        content: message.content,
        joinedTimestamp: message.joinedTimestamp,
        mentionsEveryone: message.mentionsEveryone,
        observedAtTimestamp: message.observedAtTimestamp,
      });

      if (!analysis.isLikelyScam) {
        return {
          ...ignoredResult(),
          analysis,
        };
      }

      const claim = claimMessageId(
        recentMessageIds,
        message.messageId,
        message.observedAtTimestamp,
      );
      recentMessageIds = claim.nextEntries;
      if (!claim.claimed) {
        return {
          analysis,
          duplicate: true,
          failedActions: [],
          handled: true,
          protectedMember: message.protectedMember,
        };
      }

      let failedActions: ScamModerationActionId[] = [];
      const runAction = async (
        actionId: ScamModerationActionId,
        action: () => Promise<void>,
      ) => {
        try {
          await action();
          return true;
        } catch {
          failedActions = [...failedActions, actionId];
          return false;
        }
      };

      const messageDeleted = await runAction('delete_message', () =>
        actions.deleteMessage(message.channelId, message.messageId),
      );
      if (!messageDeleted) {
        recentMessageIds = releaseClaim(recentMessageIds, message.messageId);
      }

      if (!message.protectedMember) {
        if (message.roleIds.includes(config.verifiedRoleId)) {
          await runAction('remove_verified_role', () =>
            actions.removeVerifiedRole(
              config.guildId,
              message.userId,
              config.verifiedRoleId,
            ),
          );
        }

        if (!message.roleIds.includes(config.restrictedRoleId)) {
          await runAction('add_restricted_role', () =>
            actions.addRestrictedRole(
              config.guildId,
              message.userId,
              config.restrictedRoleId,
            ),
          );
        }
      }

      if (messageDeleted && !message.protectedMember) {
        const announcementClaim = claimExpiringKey(
          recentAnnouncementChannelIds,
          message.channelId,
          message.observedAtTimestamp,
          ANNOUNCEMENT_COOLDOWN_MS,
          MAX_ANNOUNCEMENT_CHANNEL_ENTRIES,
        );
        recentAnnouncementChannelIds = announcementClaim.nextEntries;

        if (announcementClaim.claimed) {
          await runAction('send_public_announcement', () =>
            actions.sendPublicAnnouncement(
              message.channelId,
              PUBLIC_ANNOUNCEMENT_COPY,
            ),
          );
        }
      }

      if (config.alertChannelId) {
        await runAction('send_alert', () =>
          actions.sendAlert(config.alertChannelId!, {
            channelId: message.channelId,
            eventType: message.eventType,
            failedActions,
            guildId: config.guildId,
            messageId: message.messageId,
            protectedMember: message.protectedMember,
            score: analysis.score,
            signalIds: analysis.signalIds,
            userId: message.userId,
          }),
        );
      }

      return {
        analysis,
        duplicate: false,
        failedActions,
        handled: true,
        protectedMember: message.protectedMember,
      };
    },
  };
}

function shouldInspectMessage(
  message: ScamMessageContext,
  config: ScamModerationConfig,
) {
  return (
    config.enabled &&
    message.guildId === config.guildId &&
    message.content.trim().length > 0 &&
    message.userId.trim().length > 0 &&
    message.messageId.trim().length > 0 &&
    message.channelId.trim().length > 0 &&
    !message.authorBot &&
    !message.system &&
    !message.webhookId &&
    !config.excludedChannelIds.has(message.channelId)
  );
}

function ignoredResult(): ScamModerationResult {
  return {
    analysis: null,
    duplicate: false,
    failedActions: [],
    handled: false,
    protectedMember: false,
  };
}

function claimMessageId(
  entries: ReadonlyMap<string, number>,
  messageId: string,
  now: number,
) {
  return claimExpiringKey(
    entries,
    messageId,
    now,
    DEDUPLICATION_TTL_MS,
    MAX_DEDUPLICATION_ENTRIES,
  );
}

function claimExpiringKey(
  entries: ReadonlyMap<string, number>,
  key: string,
  now: number,
  ttlMs: number,
  maxEntries: number,
) {
  const activeEntries = [...entries].filter(([, expiresAt]) => expiresAt > now);
  const activeMap = new Map(activeEntries);
  if (activeMap.has(key)) {
    return { claimed: false, nextEntries: activeMap };
  }

  const boundedEntries =
    activeMap.size >= maxEntries
      ? [...activeMap]
          .sort((left, right) => left[1] - right[1])
          .slice(activeMap.size - maxEntries + 1)
      : [...activeMap];

  return {
    claimed: true,
    nextEntries: new Map([...boundedEntries, [key, now + ttlMs] as const]),
  };
}

function releaseClaim(entries: ReadonlyMap<string, number>, key: string) {
  return new Map([...entries].filter(([entryKey]) => entryKey !== key));
}
