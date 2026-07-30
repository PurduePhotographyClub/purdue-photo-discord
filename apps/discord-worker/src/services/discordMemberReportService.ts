import {
  InteractionResponseType,
  MessageComponentTypes,
} from 'discord-interactions';
import {
  DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION,
  DISCORD_ROLE_IDS,
} from '../config/discord-role-ids';
import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { ephemeralResponse } from '../discord/responses';
import type {
  ApplicationCommandInteraction,
  ComponentInteraction,
  DiscordEmbed,
  DiscordInteractionResponse,
  Env,
  ModalSubmitInteraction,
} from '../discord/types';
import { parseMemberReportProjection } from '../internal-events/parser';
import type { MemberReportProjection } from '../internal-events/types';
import { DiscordApiError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import {
  editDiscordMessage,
  sendDiscordMessage,
} from './discordMessageService';
import { requestWebsiteApi } from './websiteApiService';

const ACTION_ROW = 1;
const BUTTON = 2;
const SECONDARY_BUTTON = 2;
const INPUT_TEXT = 4;
const SHORT_TEXT = 1;
const PARAGRAPH_TEXT = 2;
const LABEL = 18;
const REPORT_NAME_CUSTOM_ID = 'member_report_name';
const REPORT_BEHAVIOR_CUSTOM_ID = 'member_report_behavior';
const REPORT_REASON_CUSTOM_ID = 'member_report_reason';
const CORRECT_MEMBER_CUSTOM_ID = 'member_report_correct_user';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const logger = createLogger('member-reports');

export const MEMBER_REPORT_CHANNEL_ID = DISCORD_CHANNEL_IDS.memberReports;
export const MEMBER_REPORT_MODAL_CUSTOM_ID = 'member_report_submit';
export const MEMBER_REPORT_CORRECT_CUSTOM_ID_PREFIX = 'member_report_correct:';
export const MEMBER_REPORT_CORRECT_MODAL_CUSTOM_ID_PREFIX =
  'member_report_correct_modal:';

interface MemberReportApiResponse {
  ok?: boolean;
  report?: unknown;
  reports?: unknown;
}

interface MemberReportMessageResult {
  channelId: string;
  created: boolean;
  messageId: string;
}

type ModalValue = boolean | string | string[];

export function handleMemberReportCommand(
  interaction: ApplicationCommandInteraction,
): DiscordInteractionResponse {
  if (!hasPpcMemberRole(interaction)) {
    return memberRoleRequiredResponse();
  }

  return {
    data: createMemberReportModalPayload(),
    type: InteractionResponseType.MODAL,
  };
}

export function isMemberReportModalCustomId(customId: string): boolean {
  return customId === MEMBER_REPORT_MODAL_CUSTOM_ID;
}

export function isMemberReportCorrectionButtonCustomId(
  customId: string,
): boolean {
  return (
    readReportIdFromCustomId(
      customId,
      MEMBER_REPORT_CORRECT_CUSTOM_ID_PREFIX,
    ) !== null
  );
}

export function isMemberReportCorrectionModalCustomId(
  customId: string,
): boolean {
  return (
    readReportIdFromCustomId(
      customId,
      MEMBER_REPORT_CORRECT_MODAL_CUSTOM_ID_PREFIX,
    ) !== null
  );
}

export async function handleMemberReportModalSubmit(
  interaction: ModalSubmitInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  if (!isMemberReportModalCustomId(interaction.data.custom_id)) {
    return ephemeralResponse('I could not identify that report form.');
  }

  if (!hasPpcMemberRole(interaction)) {
    return memberRoleRequiredResponse();
  }

  const discordId = readActorDiscordId(interaction);
  if (!discordId) {
    return ephemeralResponse('I could not identify your Discord account.');
  }

  const interactionId = readDiscordSnowflake(interaction.id);
  if (!interactionId) {
    return ephemeralResponse(
      'I could not verify this report submission. Open /report and try again.',
    );
  }

  const values = readModalValues(interaction);
  const reportedName = readModalString(values.get(REPORT_NAME_CUSTOM_ID));
  const behavior = readModalString(values.get(REPORT_BEHAVIOR_CUSTOM_ID));
  const reason = readModalString(values.get(REPORT_REASON_CUSTOM_ID));
  const validationError = validateReportInput(reportedName, behavior, reason);
  if (validationError) {
    return ephemeralResponse(validationError);
  }

  try {
    const response = await requestWebsiteApi(
      env,
      '/member-reports/by-discord',
      {
        body: { behavior, discordId, interactionId, reason, reportedName },
        method: 'POST',
      },
    );
    const reports = readMemberReportApiReports(response, {
      requirePrimaryReport: true,
    });
    await syncMemberReportProjections(env, reports);

    return ephemeralResponse(
      'Your report was submitted anonymously. The Executive team can review it now.',
    );
  } catch (error) {
    logger.warn('Anonymous member report submission failed.', { error });
    return ephemeralResponse(
      'I could not submit your report. Please try again, or use the website report form.',
    );
  }
}

export function handleMemberReportCorrectionButton(
  interaction: ComponentInteraction,
): DiscordInteractionResponse {
  const reportId = readReportIdFromCustomId(
    interaction.data.custom_id,
    MEMBER_REPORT_CORRECT_CUSTOM_ID_PREFIX,
  );
  if (!reportId) {
    return ephemeralResponse('I could not identify that member report.');
  }

  if (!canCorrectMemberReports(interaction)) {
    return correctionRoleRequiredResponse();
  }

  return {
    data: createMemberReportCorrectionModalPayload(reportId),
    type: InteractionResponseType.MODAL,
  };
}

export async function handleMemberReportCorrectionModalSubmit(
  interaction: ModalSubmitInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const reportId = readReportIdFromCustomId(
    interaction.data.custom_id,
    MEMBER_REPORT_CORRECT_MODAL_CUSTOM_ID_PREFIX,
  );
  if (!reportId) {
    return ephemeralResponse('I could not identify that member report.');
  }

  if (!canCorrectMemberReports(interaction)) {
    return correctionRoleRequiredResponse();
  }

  const discordId = readActorDiscordId(interaction);
  if (!discordId) {
    return ephemeralResponse('I could not identify your Discord account.');
  }

  const selectedUsers = readModalStringArray(
    readModalValues(interaction).get(CORRECT_MEMBER_CUSTOM_ID),
  );
  const reportedDiscordId = selectedUsers[0];
  if (
    selectedUsers.length !== 1 ||
    !reportedDiscordId ||
    !DISCORD_SNOWFLAKE_PATTERN.test(reportedDiscordId)
  ) {
    return ephemeralResponse('Select one Discord member for this report.');
  }

  try {
    const response = await requestWebsiteApi(
      env,
      `/admin/member-reports/${encodeURIComponent(reportId)}/match-by-discord`,
      {
        body: { discordId, reportedDiscordId },
        method: 'POST',
      },
    );
    const reports = readMemberReportApiReports(response);
    const results = await syncMemberReportProjections(env, reports);
    const messageCount = results.length;

    return ephemeralResponse(
      `Member match corrected. Updated ${messageCount} report message${
        messageCount === 1 ? '' : 's'
      }.`,
    );
  } catch (error) {
    logger.warn('Member report correction failed.', { error, reportId });
    return ephemeralResponse(
      'I could not correct that match. Try again from the admin dashboard.',
    );
  }
}

export async function syncMemberReportProjection(
  env: Env,
  projection: MemberReportProjection,
): Promise<MemberReportMessageResult> {
  const result = await postMemberReportMessage(env, projection);
  if (result.created) {
    await persistMemberReportMessageId(env, projection.reportId, result);
  }

  return result;
}

export async function postMemberReportMessage(
  env: Env,
  projection: MemberReportProjection,
): Promise<MemberReportMessageResult> {
  const payload = createMemberReportMessagePayload(projection);
  if (!projection.messageId) {
    const result = await sendDiscordMessage(env, {
      channelId: MEMBER_REPORT_CHANNEL_ID,
      nonce: createMemberReportNonce(projection.reportId),
      ...payload,
    });

    return {
      channelId: MEMBER_REPORT_CHANNEL_ID,
      created: true,
      messageId: requireDiscordMessageId(result),
    };
  }

  try {
    const result = await editDiscordMessage(env, {
      channelId: MEMBER_REPORT_CHANNEL_ID,
      messageId: projection.messageId,
      ...payload,
    });

    return {
      channelId: MEMBER_REPORT_CHANNEL_ID,
      created: false,
      messageId: readDiscordMessageId(result) ?? projection.messageId,
    };
  } catch (error) {
    if (!(error instanceof DiscordApiError) || error.status !== 404) {
      throw error;
    }

    logger.warn(
      'Stored member report message was missing; posting a replacement.',
      {
        messageId: projection.messageId,
        reportId: projection.reportId,
      },
    );
    const replacement = await sendDiscordMessage(env, {
      channelId: MEMBER_REPORT_CHANNEL_ID,
      nonce: createMemberReportNonce(projection.reportId),
      ...payload,
    });

    return {
      channelId: MEMBER_REPORT_CHANNEL_ID,
      created: true,
      messageId: requireDiscordMessageId(replacement),
    };
  }
}

function createMemberReportModalPayload() {
  return {
    components: [
      createTextInputLabel({
        customId: REPORT_NAME_CUSTOM_ID,
        description: 'Use the name they are known by in the club.',
        label: 'Member name',
        maxLength: 120,
        minLength: 2,
        placeholder: 'Enter the member’s name',
        style: SHORT_TEXT,
      }),
      createTextInputLabel({
        customId: REPORT_BEHAVIOR_CUSTOM_ID,
        description: 'Your identity is not included with the report.',
        label: 'What happened?',
        maxLength: 2_000,
        minLength: 20,
        placeholder: 'Describe what happened and include useful context',
        style: PARAGRAPH_TEXT,
      }),
      createTextInputLabel({
        customId: REPORT_REASON_CUSTOM_ID,
        description:
          'Add anything that would help the Executive team review it.',
        label: 'Reason (optional)',
        maxLength: 500,
        placeholder: 'Explain why you are reporting this',
        required: false,
        style: PARAGRAPH_TEXT,
      }),
    ],
    custom_id: MEMBER_REPORT_MODAL_CUSTOM_ID,
    title: 'Report member behaviour',
  };
}

function createTextInputLabel(options: {
  customId: string;
  description: string;
  label: string;
  maxLength: number;
  minLength?: number;
  placeholder: string;
  required?: boolean;
  style: number;
}) {
  return {
    component: {
      custom_id: options.customId,
      max_length: options.maxLength,
      placeholder: options.placeholder,
      required: options.required ?? true,
      style: options.style,
      type: INPUT_TEXT,
      ...(options.minLength !== undefined
        ? { min_length: options.minLength }
        : {}),
    },
    description: options.description,
    label: options.label,
    type: LABEL,
  };
}

function createMemberReportCorrectionModalPayload(reportId: string) {
  return {
    components: [
      {
        component: {
          custom_id: CORRECT_MEMBER_CUSTOM_ID,
          max_values: 1,
          min_values: 1,
          placeholder: 'Select the correct member',
          required: true,
          type: MessageComponentTypes.USER_SELECT,
        },
        description: 'All reports matched to this member will be recounted.',
        label: 'Correct member',
        type: LABEL,
      },
    ],
    custom_id: `${MEMBER_REPORT_CORRECT_MODAL_CUSTOM_ID_PREFIX}${reportId}`,
    title: 'Correct member match',
  };
}

function createMemberReportMessagePayload(projection: MemberReportProjection) {
  const reason = projection.reason?.trim();
  const reasonField = reason
    ? [
        {
          inline: false,
          name: 'Reason',
          value: reason,
        },
      ]
    : [];
  const submittedNameField =
    projection.submittedName.localeCompare(projection.reportedName, undefined, {
      sensitivity: 'accent',
    }) === 0
      ? []
      : [
          {
            inline: false,
            name: 'Submitted name',
            value: projection.submittedName,
          },
        ];
  const embed: DiscordEmbed = {
    color: getMemberReportColor(projection.relatedReportCount),
    description: projection.behavior,
    fields: [
      {
        inline: true,
        name: 'Reported member',
        value: projection.reportedName,
      },
      {
        inline: true,
        name: 'Matched reports',
        value: String(projection.relatedReportCount),
      },
      {
        inline: true,
        name: 'Name match',
        value: getMatchMethodLabel(projection.matchMethod),
      },
      ...submittedNameField,
      ...reasonField,
    ],
    footer: {
      text: `Anonymous report ${projection.reportId}`,
    },
    timestamp: projection.submittedAt,
    title: 'Anonymous member report',
  };

  return {
    components: [
      {
        components: [
          {
            custom_id: `${MEMBER_REPORT_CORRECT_CUSTOM_ID_PREFIX}${projection.reportId}`,
            label: 'Correct member match',
            style: SECONDARY_BUTTON,
            type: BUTTON,
          },
        ],
        type: ACTION_ROW,
      },
    ],
    embeds: [embed],
  };
}

function getMemberReportColor(reportCount: number): number {
  if (reportCount >= 3) {
    return 0xef4444;
  }

  return reportCount === 2 ? 0xf97316 : 0xf2c94c;
}

function getMatchMethodLabel(
  matchMethod: MemberReportProjection['matchMethod'],
): string {
  switch (matchMethod) {
    case 'exact':
      return 'Exact name match';
    case 'similar':
      return 'Similar name match';
    case 'manual':
      return 'Manually corrected';
    case 'unmatched':
      return 'No member match';
  }
}

async function syncMemberReportProjections(
  env: Env,
  projections: MemberReportProjection[],
): Promise<MemberReportMessageResult[]> {
  return Promise.all(
    projections.map((projection) =>
      syncMemberReportProjection(env, projection),
    ),
  );
}

async function persistMemberReportMessageId(
  env: Env,
  reportId: string,
  result: MemberReportMessageResult,
): Promise<void> {
  await requestWebsiteApi(
    env,
    `/member-reports/${encodeURIComponent(reportId)}/sync-result-by-discord`,
    {
      body: {
        channelId: result.channelId,
        messageId: result.messageId,
      },
      method: 'POST',
    },
  );
}

function readMemberReportApiReports(
  value: unknown,
  options: { requirePrimaryReport?: boolean } = {},
): MemberReportProjection[] {
  if (!isRecord(value)) {
    throw new Error('Member report API response must be an object.');
  }

  const response = value as MemberReportApiResponse;
  if (response.ok !== true) {
    throw new Error('Member report API response was not successful.');
  }

  if (!Array.isArray(response.reports) || response.reports.length === 0) {
    throw new Error('Member report API response did not include reports.');
  }

  if (options.requirePrimaryReport) {
    if (response.report === undefined) {
      throw new Error(
        'Member report API response did not include the submitted report.',
      );
    }
    parseMemberReportProjection(response.report);
  }

  return response.reports.map((report) => parseMemberReportProjection(report));
}

function createMemberReportNonce(reportId: string): string {
  return BigInt(`0x${reportId.replaceAll('-', '')}`).toString(36);
}

function validateReportInput(
  reportedName: string | null,
  behavior: string | null,
  reason: string | null,
): string | undefined {
  if (!reportedName || reportedName.length < 2 || reportedName.length > 120) {
    return 'Enter a member name between 2 and 120 characters.';
  }

  if (!behavior || behavior.length < 20 || behavior.length > 2_000) {
    return 'Describe what happened in 20 to 2,000 characters.';
  }

  if (reason && countUnicodeCharacters(reason) > 500) {
    return 'Keep the optional reason to 500 characters or fewer.';
  }

  return undefined;
}

function countUnicodeCharacters(value: string): number {
  return Array.from(value).length;
}

function hasPpcMemberRole(interaction: {
  member?: { roles?: string[] };
}): boolean {
  return Boolean(
    interaction.member?.roles?.includes(
      DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION.memberRoleId,
    ),
  );
}

function canCorrectMemberReports(interaction: {
  member?: { roles?: string[] };
}): boolean {
  const roles = interaction.member?.roles ?? [];
  return roles.includes(DISCORD_ROLE_IDS.executive);
}

function memberRoleRequiredResponse(): DiscordInteractionResponse {
  return ephemeralResponse(
    'You need the PPC Member role before you can submit a report.',
  );
}

function correctionRoleRequiredResponse(): DiscordInteractionResponse {
  return ephemeralResponse(
    'Only the Executive role can correct report matches.',
  );
}

function readActorDiscordId(interaction: {
  member?: { user?: { id?: string } };
  user?: { id?: string };
}): string | null {
  const discordId = interaction.member?.user?.id ?? interaction.user?.id;
  return readDiscordSnowflake(discordId);
}

function readDiscordSnowflake(value: string | undefined): string | null {
  return value && DISCORD_SNOWFLAKE_PATTERN.test(value) ? value : null;
}

function readReportIdFromCustomId(
  customId: string,
  prefix: string,
): string | null {
  if (!customId.startsWith(prefix)) {
    return null;
  }

  const reportId = customId.slice(prefix.length);
  return UUID_PATTERN.test(reportId) ? reportId : null;
}

function readModalValues(interaction: ModalSubmitInteraction) {
  const components = interaction.data.components ?? [];
  return components.reduce<Map<string, ModalValue>>((values, row) => {
    if (!isRecord(row)) {
      return values;
    }

    const rowComponents = [
      ...(isRecord(row.component) ? [row.component] : []),
      ...(Array.isArray(row.components) ? row.components : []),
    ];

    return rowComponents.reduce((nextValues, component) => {
      if (!isRecord(component) || typeof component.custom_id !== 'string') {
        return nextValues;
      }

      const value = readModalComponentValue(component);
      return value === undefined
        ? nextValues
        : new Map(nextValues).set(component.custom_id, value);
    }, values);
  }, new Map<string, ModalValue>());
}

function readModalComponentValue(
  component: Record<string, unknown>,
): ModalValue | undefined {
  if (
    typeof component.value === 'boolean' ||
    typeof component.value === 'string'
  ) {
    return component.value;
  }

  if (
    Array.isArray(component.values) &&
    component.values.every((value) => typeof value === 'string')
  ) {
    return component.values;
  }

  return undefined;
}

function readModalString(value: ModalValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readModalStringArray(value: ModalValue | undefined): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const trimmedItem = item.trim();
        return trimmedItem ? [trimmedItem] : [];
      })
    : [];
}

function requireDiscordMessageId(result: unknown): string {
  const messageId = readDiscordMessageId(result);
  if (!messageId) {
    throw new Error('Discord did not return a message ID.');
  }

  return messageId;
}

function readDiscordMessageId(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }

  return typeof result.id === 'string' &&
    DISCORD_SNOWFLAKE_PATTERN.test(result.id)
    ? result.id
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
