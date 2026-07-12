import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import { discordApiRequest } from '../discord/api';
import { ephemeralResponse } from '../discord/responses';
import type {
  ComponentInteraction,
  DiscordEmbed,
  DiscordInteractionResponse,
  Env,
} from '../discord/types';
import type { EquipmentLoanSyncInternalEvent } from '../internal-events/types';
import { getOptionalEnv, getRequiredEnv } from '../utils/env';
import { DiscordApiError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import {
  editDiscordMessage,
  sendDiscordDirectMessage,
  sendDiscordMessage,
} from './discordMessageService';
import { requestWebsiteApi } from './websiteApiService';

const EQUIPMENT_LOAN_CATEGORY_ID = '1512504813005574164';
const EQUIPMENT_LOAN_ARCHIVE_CATEGORY_ID = '1512863825735585943';
const EQUIPMENT_TERMS_CHANNEL_ID = '1512505024792760421';
const ACTION_ROW = 1;
const BUTTON = 2;
const PRIMARY_BUTTON = 1;
const SUCCESS_BUTTON = 3;
const SECONDARY_BUTTON = 2;
const DANGER_BUTTON = 4;
const LINK_BUTTON = 5;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const ATTACH_FILES = 1n << 15n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const CHANNEL_ACCESS = String(
  VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | READ_MESSAGE_HISTORY,
);

const logger = createLogger('equipment-loans');

export const EQUIPMENT_TERMS_ACCEPT_CUSTOM_ID = 'equipment_terms:accept';
export const EQUIPMENT_TERMS_DENY_CUSTOM_ID = 'equipment_terms:deny';
export const EQUIPMENT_LOAN_ACTION_CUSTOM_ID_PREFIX = 'equipment_loan:';

interface DiscordChannel {
  id: string;
}

interface DiscordMessageResult {
  id?: string;
}

interface WebsiteActionResponse {
  message?: string;
  ok?: boolean;
}

export function isEquipmentTermsButtonCustomId(customId: string) {
  return (
    customId === EQUIPMENT_TERMS_ACCEPT_CUSTOM_ID ||
    customId === EQUIPMENT_TERMS_DENY_CUSTOM_ID
  );
}

export function isEquipmentLoanActionButtonCustomId(customId: string) {
  return parseEquipmentLoanActionCustomId(customId) !== null;
}

export async function handleEquipmentTermsButton(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const discordId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!discordId) {
    return ephemeralResponse('I could not identify your Discord account.');
  }

  const decision =
    interaction.data.custom_id === EQUIPMENT_TERMS_ACCEPT_CUSTOM_ID
      ? 'accept'
      : 'deny';

  try {
    const response = await requestWebsiteApi(
      env,
      '/equipment/terms/by-discord',
      {
        body: { decision, discordId },
        method: 'POST',
      },
    );
    const result = readWebsiteActionResponse(response);

    return ephemeralResponse(
      result.message ??
        (result.ok
          ? 'Equipment terms updated.'
          : 'I could not update your equipment terms.'),
    );
  } catch (error) {
    logger.warn('Equipment terms button API request failed.', { error });
    return ephemeralResponse(
      'I could not update your equipment terms. Make sure your website account is linked to Discord.',
    );
  }
}

export async function handleEquipmentLoanActionButton(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const parsed = parseEquipmentLoanActionCustomId(interaction.data.custom_id);
  const discordId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!parsed || !discordId) {
    return ephemeralResponse('I could not identify this equipment loan.');
  }

  try {
    const response = await requestWebsiteApi(
      env,
      `/loans/${encodeURIComponent(parsed.loanId)}/action-by-discord`,
      {
        body: {
          action: parsed.action,
          discordId,
        },
        method: 'POST',
      },
    );
    const result = readWebsiteActionResponse(response);

    return ephemeralResponse(
      result.message ??
        (result.ok
          ? 'Equipment loan updated.'
          : 'I could not update that equipment loan.'),
    );
  } catch (error) {
    logger.warn('Equipment loan action API request failed.', { error });
    return ephemeralResponse(
      'I could not update that equipment loan. Try again from the equipment dashboard.',
    );
  }
}

export async function postEquipmentTermsMessage(env: Env) {
  const result = await sendDiscordMessage(
    env,
    createEquipmentTermsPayload(env),
  );

  return {
    channelId: EQUIPMENT_TERMS_CHANNEL_ID,
    messageId: readMessageId(result),
  };
}

export async function syncEquipmentLoanChannel(
  env: Env,
  event: EquipmentLoanSyncInternalEvent,
) {
  let channelId = event.channelId ?? null;

  if (event.reminderKind) {
    const reminderResult = await sendEquipmentLoanReminder(
      env,
      channelId,
      event,
    );
    return {
      channelId: reminderResult.staleChannel ? null : channelId,
      messageId: reminderResult.staleChannel ? null : (event.messageId ?? null),
      reminderDelivered: reminderResult.reminderDelivered,
      staleChannel: reminderResult.staleChannel,
    };
  }

  if (!channelId) {
    if (!shouldCreateLoanChannel(event)) {
      await notifyEquipmentLoanParticipants(env, event);

      return {
        channelId: null,
        messageId: event.messageId ?? null,
      };
    }

    const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
    const channel = await createEquipmentLoanChannel(env, guildId, event);
    channelId = channel.id;
  } else if (event.updateChannel === true) {
    await updateEquipmentLoanChannel(env, channelId, event);
  }

  await reconcileEquipmentLoanPermissions(env, channelId, event);

  const messageResult = event.messageId
    ? await editOrSendEquipmentLoanMessage(
        env,
        channelId,
        event.messageId,
        event,
      )
    : await sendEquipmentLoanMessage(env, channelId, event);

  await notifyEquipmentLoanParticipants(env, event);

  return {
    channelId,
    messageId: readMessageId(messageResult) ?? event.messageId ?? null,
  };
}

function createEquipmentTermsPayload(env: Env): {
  channelId: string;
  components: unknown[];
  embeds: DiscordEmbed[];
} {
  const websiteUrl = getWebsiteUrl(env);

  return {
    channelId: EQUIPMENT_TERMS_CHANNEL_ID,
    components: [
      {
        components: [
          {
            custom_id: EQUIPMENT_TERMS_ACCEPT_CUSTOM_ID,
            label: 'Accept',
            style: SUCCESS_BUTTON,
            type: BUTTON,
          },
          {
            custom_id: EQUIPMENT_TERMS_DENY_CUSTOM_ID,
            label: 'Deny',
            style: DANGER_BUTTON,
            type: BUTTON,
          },
          {
            label: 'Open equipment dashboard',
            style: LINK_BUTTON,
            type: BUTTON,
            url: `${websiteUrl}/dashboard/equipment`,
          },
        ],
        type: ACTION_ROW,
      },
    ],
    embeds: [
      {
        color: 0xf2c94c,
        description: [
          'Accept these PPC equipment terms once before borrowing club gear or listing personal gear.',
          'Borrowers are responsible for safe handling, timely return, and prompt damage/loss reporting.',
          'Personal gear terms are set by the member listing that item.',
        ].join('\n'),
        footer: {
          text: 'Purdue Photography Club equipment loans',
        },
        title: 'Equipment Loan Terms',
      },
    ],
  };
}

function shouldCreateLoanChannel(event: EquipmentLoanSyncInternalEvent) {
  return event.status === 'active' || event.status === 'pending_return';
}

async function createEquipmentLoanChannel(
  env: Env,
  guildId: string,
  event: EquipmentLoanSyncInternalEvent,
): Promise<DiscordChannel> {
  return discordApiRequest<DiscordChannel>(env, `/guilds/${guildId}/channels`, {
    body: JSON.stringify({
      name: buildEquipmentLoanChannelName(event),
      parent_id: getEquipmentLoanCategoryId(event),
      permission_overwrites: buildInitialPermissionOverwrites(guildId),
      topic: buildEquipmentLoanTopic(event),
      type: 0,
    }),
    method: 'POST',
  });
}

async function updateEquipmentLoanChannel(
  env: Env,
  channelId: string,
  event: EquipmentLoanSyncInternalEvent,
) {
  await discordApiRequest(env, `/channels/${channelId}`, {
    body: JSON.stringify({
      name: buildEquipmentLoanChannelName(event),
      parent_id: getEquipmentLoanCategoryId(event),
      topic: buildEquipmentLoanTopic(event),
    }),
    method: 'PATCH',
  });
}

async function reconcileEquipmentLoanPermissions(
  env: Env,
  channelId: string,
  event: EquipmentLoanSyncInternalEvent,
) {
  await Promise.all([
    allowMemberInEquipmentLoanChannel(env, channelId, event.borrower.discordId),
    ...(event.lender?.discordId
      ? [
          allowMemberInEquipmentLoanChannel(
            env,
            channelId,
            event.lender.discordId,
          ),
        ]
      : []),
  ]);
}

async function allowMemberInEquipmentLoanChannel(
  env: Env,
  channelId: string,
  discordId: string,
) {
  await discordApiRequest(
    env,
    `/channels/${channelId}/permissions/${discordId}`,
    {
      body: JSON.stringify({
        allow: CHANNEL_ACCESS,
        deny: '0',
        type: 1,
      }),
      method: 'PUT',
    },
  );
}

async function sendEquipmentLoanMessage(
  env: Env,
  channelId: string,
  event: EquipmentLoanSyncInternalEvent,
) {
  return sendDiscordMessage(env, {
    channelId,
    components: buildEquipmentLoanComponents(env, event),
    content: buildEquipmentLoanContent(event),
    embeds: [buildEquipmentLoanEmbed(event)],
  });
}

async function editOrSendEquipmentLoanMessage(
  env: Env,
  channelId: string,
  messageId: string,
  event: EquipmentLoanSyncInternalEvent,
) {
  try {
    return await editDiscordMessage(env, {
      channelId,
      components: buildEquipmentLoanComponents(env, event),
      content: buildEquipmentLoanContent(event),
      embeds: [buildEquipmentLoanEmbed(event)],
      messageId,
    });
  } catch (error) {
    if (isDiscordNotFoundError(error)) {
      return sendEquipmentLoanMessage(env, channelId, event);
    }

    throw error;
  }
}

async function sendEquipmentLoanReminder(
  env: Env,
  channelId: string | null,
  event: EquipmentLoanSyncInternalEvent,
) {
  const content =
    event.reminderKind === 'overdue'
      ? `Equipment loan overdue: ${event.equipment.name} was due ${formatPlainDate(event.dueDate)}. Please coordinate return.`
      : `Equipment loan reminder: ${event.equipment.name} is due ${formatPlainDate(event.dueDate)}.`;
  const reminderRecipients = unique([
    event.borrower.discordId,
    event.lender?.discordId ?? '',
  ]);

  const deliveryResults = await Promise.allSettled([
    ...(channelId
      ? [
          sendDiscordMessage(env, {
            channelId,
            content,
            nonce: createEquipmentReminderNonce(event, `channel:${channelId}`),
          }),
        ]
      : []),
    ...reminderRecipients.map((recipientId) =>
      sendDiscordDirectMessage(env, {
        content,
        nonce: createEquipmentReminderNonce(event, `dm:${recipientId}`),
        recipientId,
      }),
    ),
  ]);
  const failedDeliveries = deliveryResults.filter(
    (result) => result.status === 'rejected',
  ).length;
  const channelResult = channelId ? deliveryResults[0] : null;
  const borrowerResult = deliveryResults[channelId ? 1 : 0];
  const reminderDelivered =
    channelResult?.status === 'fulfilled' ||
    borrowerResult?.status === 'fulfilled';
  const staleChannel =
    channelResult?.status === 'rejected' &&
    isDiscordNotFoundError(channelResult.reason);

  if (failedDeliveries > 0 || !reminderDelivered) {
    logger.warn('Some equipment reminder deliveries failed.', {
      channelAttempted: !!channelId,
      failedDeliveries,
      reminderDelivered,
      recipientCount: reminderRecipients.length,
      staleChannel,
    });
  }

  return { reminderDelivered, staleChannel };
}

function createEquipmentReminderNonce(
  event: EquipmentLoanSyncInternalEvent,
  destination: string,
) {
  const value = `${event.loanId}:${event.reminderKind}:${destination}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }

  return `eq-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

async function notifyEquipmentLoanParticipants(
  env: Env,
  event: EquipmentLoanSyncInternalEvent,
) {
  const notifications = [
    {
      content: buildEquipmentLoanDmContent(env, event, 'borrower'),
      discordId: event.borrower.discordId,
    },
    ...(event.lender?.discordId
      ? [
          {
            content: buildEquipmentLoanDmContent(env, event, 'lender'),
            discordId: event.lender.discordId,
          },
        ]
      : []),
  ];
  const byDiscordId = new Map(
    notifications.map((notification) => [notification.discordId, notification]),
  );

  await Promise.allSettled(
    Array.from(byDiscordId.values()).map((notification) =>
      sendDiscordDirectMessage(env, {
        content: notification.content,
        recipientId: notification.discordId,
      }),
    ),
  );
}

function buildInitialPermissionOverwrites(guildId: string) {
  return [
    {
      allow: '0',
      deny: String(VIEW_CHANNEL),
      id: guildId,
      type: 0,
    },
    ...unique([DISCORD_ROLE_IDS.admin, DISCORD_ROLE_IDS.executive]).map(
      (roleId) => ({
        allow: CHANNEL_ACCESS,
        deny: '0',
        id: roleId,
        type: 0,
      }),
    ),
  ];
}

function buildEquipmentLoanComponents(
  env: Env,
  event: EquipmentLoanSyncInternalEvent,
) {
  const websiteUrl = getWebsiteUrl(env);
  const actionButton =
    event.status === 'active'
      ? {
          custom_id: `${EQUIPMENT_LOAN_ACTION_CUSTOM_ID_PREFIX}return:${event.loanId}`,
          label: 'Mark ready to return',
          style: PRIMARY_BUTTON,
          type: BUTTON,
        }
      : event.status === 'pending_return'
        ? {
            custom_id: `${EQUIPMENT_LOAN_ACTION_CUSTOM_ID_PREFIX}confirm_return:${event.loanId}`,
            label: 'Confirm return',
            style: SUCCESS_BUTTON,
            type: BUTTON,
          }
        : {
            custom_id: `${EQUIPMENT_LOAN_ACTION_CUSTOM_ID_PREFIX}noop:${event.loanId}`,
            disabled: true,
            label: formatLoanStatus(event.status),
            style: SECONDARY_BUTTON,
            type: BUTTON,
          };

  return [
    {
      components: [
        actionButton,
        {
          label: 'Open equipment dashboard',
          style: LINK_BUTTON,
          type: BUTTON,
          url: `${websiteUrl}/dashboard/equipment`,
        },
      ],
      type: ACTION_ROW,
    },
  ];
}

function buildEquipmentLoanContent(event: EquipmentLoanSyncInternalEvent) {
  if (event.status === 'returned') {
    return 'This equipment loan has been returned.';
  }

  if (event.status === 'pending_return') {
    return 'The borrower marked this equipment ready to return. The lender or PPC staff should confirm once the item is back.';
  }

  return 'Equipment loan coordination channel. Use this space for pickup, handoff, care notes, and return details.';
}

function buildEquipmentLoanEmbed(
  event: EquipmentLoanSyncInternalEvent,
): DiscordEmbed {
  const fields = [
    {
      inline: true,
      name: 'Borrower',
      value: `${event.borrower.name} (<@${event.borrower.discordId}>)`,
    },
    {
      inline: true,
      name: 'Lender',
      value: event.lender?.discordId
        ? `${event.lender.name} (<@${event.lender.discordId}>)`
        : 'PPC Equipment Team',
    },
    {
      inline: true,
      name: 'Due',
      value: event.dueDate
        ? formatDiscordTimestamp(new Date(event.dueDate))
        : 'Not set',
    },
    {
      inline: false,
      name: 'Gear',
      value: formatEquipmentLabel(event),
    },
    ...(event.termsSnapshot
      ? [
          {
            inline: false,
            name: 'Terms snapshot',
            value: truncate(event.termsSnapshot, 900),
          },
        ]
      : []),
    ...(event.notes
      ? [
          {
            inline: false,
            name: 'Request note',
            value: truncate(event.notes, 500),
          },
        ]
      : []),
  ];

  return {
    color: getEquipmentLoanColor(event.status),
    fields,
    footer: {
      text: `Equipment loan ${event.loanId}`,
    },
    timestamp: new Date().toISOString(),
    title: `${formatLoanStatus(event.status)}: ${event.equipment.name}`,
  };
}

function buildEquipmentLoanChannelName(event: EquipmentLoanSyncInternalEvent) {
  const typePrefix = event.isPpcOwned ? 'ppc-gear' : 'personal-gear';
  const prefix =
    event.status === 'returned' ? `returned-${typePrefix}` : typePrefix;
  const label = event.equipment.assetTag || event.equipment.name;
  return sanitizeChannelName(`${prefix}-${label}-${event.borrower.name}`);
}

function buildEquipmentLoanTopic(event: EquipmentLoanSyncInternalEvent) {
  return truncate(
    [
      `${event.isPpcOwned ? 'PPC' : 'Personal'} equipment loan`,
      event.equipment.assetTag
        ? `${event.equipment.name} (${event.equipment.assetTag})`
        : event.equipment.name,
      `Borrower ${event.borrower.name}`,
      event.lender
        ? `Lender ${event.lender.name}`
        : 'Lender PPC Equipment Team',
      event.dueDate ? `Due ${formatPlainDate(event.dueDate)}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join(' | '),
    1_024,
  );
}

function parseEquipmentLoanActionCustomId(customId: string) {
  if (!customId.startsWith(EQUIPMENT_LOAN_ACTION_CUSTOM_ID_PREFIX)) {
    return null;
  }

  const [action, ...loanIdParts] = customId
    .slice(EQUIPMENT_LOAN_ACTION_CUSTOM_ID_PREFIX.length)
    .split(':');
  const loanId = loanIdParts.join(':').trim();
  if ((action !== 'return' && action !== 'confirm_return') || !loanId) {
    return null;
  }

  return { action, loanId };
}

function readWebsiteActionResponse(value: unknown): WebsiteActionResponse {
  if (!isRecord(value)) {
    return {};
  }

  return {
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(typeof value.ok === 'boolean' ? { ok: value.ok } : {}),
  };
}

function readMessageId(result: unknown) {
  if (!isRecord(result)) {
    return null;
  }

  const message = result as DiscordMessageResult;
  return typeof message.id === 'string' ? message.id : null;
}

function formatEquipmentLabel(event: EquipmentLoanSyncInternalEvent) {
  return [
    `**Name:** ${event.equipment.name}`,
    event.equipment.model ? `**Model:** ${event.equipment.model}` : null,
    event.equipment.assetTag
      ? `**Asset tag:** ${event.equipment.assetTag}`
      : null,
    `**Type:** ${event.isPpcOwned ? 'PPC equipment' : 'Personal gear'}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function buildEquipmentLoanDmContent(
  env: Env,
  event: EquipmentLoanSyncInternalEvent,
  role: 'borrower' | 'lender',
) {
  const dashboardPath =
    role === 'borrower'
      ? '/dashboard/equipment?tab=loans&loan=borrowed'
      : event.isPpcOwned
        ? '/dashboard/admin/equipment'
        : '/dashboard/equipment?tab=loans&loan=requests';
  const dashboardUrl = `${getWebsiteUrl(env)}${dashboardPath}`;
  const lenderName = event.isPpcOwned
    ? 'PPC Equipment Team'
    : (event.lender?.name ?? 'Member lender');
  const roleLine =
    role === 'borrower'
      ? `**Your role:** Borrower`
      : `**Your role:** ${event.isPpcOwned ? 'PPC reviewer' : 'Lender'}`;
  const dueLine = event.dueDate
    ? `**Due:** ${formatPlainDate(event.dueDate)}`
    : null;
  const sharedDetails = [
    `**Gear**`,
    formatEquipmentLabel(event),
    '',
    roleLine,
    `**Borrower:** ${event.borrower.name}`,
    `**Lender:** ${lenderName}`,
    ...(dueLine ? [dueLine] : []),
  ];

  const buildMessage = (title: string, body: string) =>
    [
      `**${title}**`,
      '',
      ...sharedDetails,
      '',
      body,
      '',
      `**Dashboard:** ${dashboardUrl}`,
    ].join('\n');

  switch (event.status) {
    case 'pending':
      return role === 'borrower'
        ? buildMessage(
            'Equipment request submitted',
            'Your request is waiting for review.',
          )
        : buildMessage(
            'New equipment request',
            'Review the request when you are ready.',
          );
    case 'active':
      return role === 'borrower'
        ? buildMessage(
            'Equipment loan approved',
            'A coordination channel is ready in Discord.',
          )
        : buildMessage(
            'Equipment loan approved',
            'A coordination channel is ready in Discord.',
          );
    case 'pending_return':
      return role === 'borrower'
        ? buildMessage(
            'Return marked ready',
            'Waiting for the lender or PPC team to confirm it is back.',
          )
        : buildMessage(
            'Return needs confirmation',
            'Confirm the return once the item is back.',
          );
    case 'returned':
      return buildMessage('Equipment returned', 'The loan is closed.');
    case 'rejected':
      return role === 'borrower'
        ? buildMessage(
            'Equipment request denied',
            'The request was not approved.',
          )
        : buildMessage('Equipment request denied', 'The request was rejected.');
    default:
      return buildMessage('Equipment loan updated', 'The loan status changed.');
  }
}

function getEquipmentLoanCategoryId(event: EquipmentLoanSyncInternalEvent) {
  return event.status === 'returned'
    ? EQUIPMENT_LOAN_ARCHIVE_CATEGORY_ID
    : EQUIPMENT_LOAN_CATEGORY_ID;
}

function formatLoanStatus(status: EquipmentLoanSyncInternalEvent['status']) {
  switch (status) {
    case 'active':
      return 'Active Loan';
    case 'pending_return':
      return 'Pending Return';
    case 'returned':
      return 'Returned';
    case 'rejected':
      return 'Rejected';
    default:
      return 'Pending';
  }
}

function getEquipmentLoanColor(
  status: EquipmentLoanSyncInternalEvent['status'],
) {
  switch (status) {
    case 'active':
      return 0x22c55e;
    case 'pending_return':
      return 0xf59e0b;
    case 'returned':
      return 0x6b7280;
    case 'rejected':
      return 0xf85149;
    default:
      return 0xf2c94c;
  }
}

function formatDiscordTimestamp(date: Date) {
  return `<t:${Math.floor(date.getTime() / 1_000)}:f>`;
}

function formatPlainDate(value: string | null | undefined) {
  if (!value) {
    return 'not set';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Indiana/Indianapolis',
  });
}

function getWebsiteUrl(env: Env) {
  return (
    getOptionalEnv(env, 'WEBSITE_URL') ?? 'https://purduephotoclub.org'
  ).replace(/\/+$/, '');
}

function isDiscordNotFoundError(error: unknown) {
  return error instanceof DiscordApiError && error.status === 404;
}

function sanitizeChannelName(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'equipment-loan'
  );
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
