import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
} from 'discord.js';
import type { ScamModerationAlert } from './scamModerationService.js';

export type ScamReviewAction = 'confirm' | 'dismiss' | 'reviewed';

export interface ScamReviewResolution {
  action: ScamReviewAction | 'stale';
  moderatorId: string;
  result: string;
}

export interface ScamModerationAlertPayload {
  allowedMentions: { parse: [] };
  components: ActionRowBuilder<ButtonBuilder>[];
  embeds: EmbedBuilder[];
}

const REVIEW_CUSTOM_ID_PREFIX = 'scam-review';
const MAX_DESCRIPTION_LENGTH = 4_096;

export function buildScamModerationAlertPayload(
  alert: ScamModerationAlert,
  resolution?: ScamReviewResolution,
): ScamModerationAlertPayload {
  const embed = new EmbedBuilder()
    .setColor(getAlertColor(alert, resolution))
    .setTitle(getAlertTitle(alert, resolution))
    .setDescription(truncateEvidence(alert.content))
    .addFields(
      {
        inline: true,
        name: 'User',
        value: `<@${alert.userId}>\n\`${alert.userId}\``,
      },
      {
        inline: true,
        name: 'Channel',
        value: `<#${alert.channelId}>\n\`${alert.channelId}\``,
      },
      {
        inline: false,
        name: 'Message',
        value: `[Open message](${getMessageUrl(alert)})\n\`${alert.messageId}\``,
      },
      { inline: true, name: 'Event', value: alert.eventType },
      { inline: true, name: 'Score', value: String(alert.score) },
      {
        inline: false,
        name: 'Signals',
        value: truncateField(alert.signalIds.join(', ') || 'None'),
      },
      {
        inline: false,
        name: 'Result',
        value: truncateField(getAlertResult(alert, resolution)),
      },
    )
    .setFooter({ text: `Message ID: ${alert.messageId}` })
    .setTimestamp();

  return {
    allowedMentions: { parse: [] },
    components: buildReviewComponents(alert, resolution),
    embeds: [embed],
  };
}

export function parseScamReviewAction(
  customId: string,
): { action: ScamReviewAction; reviewId: string } | null {
  const match = new RegExp(
    `^${REVIEW_CUSTOM_ID_PREFIX}:(confirm|dismiss|reviewed):(\\d{17,20})$`,
    'u',
  ).exec(customId);

  if (!match) {
    return null;
  }

  return {
    action: match[1] as ScamReviewAction,
    reviewId: match[2]!,
  };
}

function buildReviewComponents(
  alert: ScamModerationAlert,
  resolution: ScamReviewResolution | undefined,
) {
  if (!alert.reviewOnly || resolution) {
    return [];
  }

  if (alert.reviewReason === 'reported_scam' || alert.protectedMember) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${REVIEW_CUSTOM_ID_PREFIX}:reviewed:${alert.messageId}`)
          .setLabel('Mark reviewed')
          .setStyle(ButtonStyle.Secondary),
      ),
    ];
  }

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${REVIEW_CUSTOM_ID_PREFIX}:confirm:${alert.messageId}`)
        .setLabel('Confirm scam')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${REVIEW_CUSTOM_ID_PREFIX}:dismiss:${alert.messageId}`)
        .setLabel('Dismiss')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function getAlertColor(
  alert: ScamModerationAlert,
  resolution: ScamReviewResolution | undefined,
) {
  if (resolution?.action === 'confirm') {
    return Colors.Red;
  }
  if (resolution) {
    return Colors.Greyple;
  }
  return alert.reviewOnly ? Colors.Orange : Colors.Red;
}

function getAlertTitle(
  alert: ScamModerationAlert,
  resolution: ScamReviewResolution | undefined,
) {
  if (resolution?.action === 'confirm') {
    return 'Scam confirmed by moderator';
  }
  if (resolution?.action === 'dismiss') {
    return 'Scam review dismissed';
  }
  if (resolution?.action === 'reviewed') {
    return 'Scam report reviewed';
  }
  if (resolution?.action === 'stale') {
    return 'Scam review could not be applied';
  }
  if (alert.reviewOnly) {
    return 'Possible scam needs review';
  }
  return alert.signalIds.includes('ticket_template_fingerprint')
    ? 'Probable ticket scam detected'
    : 'Probable giveaway scam detected';
}

function getAlertResult(
  alert: ScamModerationAlert,
  resolution: ScamReviewResolution | undefined,
) {
  if (resolution) {
    return `${resolution.result} Resolved by <@${resolution.moderatorId}> (\`${resolution.moderatorId}\`).`;
  }
  if (alert.reviewOnly) {
    return alert.reviewReason === 'reported_scam'
      ? 'Reported scam pattern; no action was taken against the reporter.'
      : 'No action taken yet.';
  }
  if (alert.protectedMember && alert.failedActions.includes('delete_message')) {
    return 'Deletion failed; protected member roles unchanged; manual follow-up required.';
  }
  if (alert.protectedMember) {
    return 'Protected member: message deleted; roles unchanged.';
  }
  if (alert.failedActions.length > 0) {
    return `Partial action: ${alert.failedActions.join(', ')} needs review.`;
  }
  return 'Message deleted; verified removed when present; Clown added.';
}

function getMessageUrl(alert: ScamModerationAlert) {
  return `https://discord.com/channels/${alert.guildId}/${alert.channelId}/${alert.messageId}`;
}

function truncateEvidence(content: string) {
  const safeContent = content
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, '')
    .replace(/https:\/\//giu, 'hxxps://')
    .replace(/http:\/\//giu, 'hxxp://')
    .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, '[.]')
    .replace(/\\/gu, '\\\\')
    .replace(/([`*_~|>#()[\]])/gu, '\\$1')
    .replace(/@(everyone|here)/giu, '@\u200B$1')
    .replace(/<(?=@[!&]?\d|#\d)/gu, '\\<')
    .trim();

  return truncate(
    safeContent || '(No message content available)',
    MAX_DESCRIPTION_LENGTH,
  );
}

function truncateField(value: string) {
  return truncate(value, 1_024);
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
