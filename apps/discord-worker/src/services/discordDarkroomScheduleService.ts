import { discordApiRequest } from '../discord/api';
import { ephemeralResponse } from '../discord/responses';
import type {
  ComponentInteraction,
  DiscordEmbed,
  DiscordInteractionResponse,
  Env,
} from '../discord/types';
import type {
  DarkroomScheduleSyncInternalEvent,
  DarkroomScheduleWeeklyJoinMessageInternalEvent,
  DarkroomScheduleWeeklyJoinSlot,
} from '../internal-events/types';
import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import { requestWebsiteApi } from './websiteApiService';
import { BadRequestError, DiscordApiError } from '../utils/errors';
import { getOptionalEnv, getRequiredEnv } from '../utils/env';
import { createLogger } from '../utils/logger';
import {
  editDiscordMessage,
  sendDiscordDirectMessage,
  sendDiscordMessage,
} from './discordMessageService';

const DARKROOM_SCHEDULE_CATEGORY_ID = '1512506913043124436';
const DARKROOM_SCHEDULE_ARCHIVE_CATEGORY_ID = '1512863825735585943';
const DARKROOM_SCHEDULE_ANCHOR_CHANNEL_ID = '1512554500853072062';
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const DANGER_BUTTON = 4;
const LINK_BUTTON = 5;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const ATTACH_FILES = 1n << 15n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const CHANNEL_ACCESS = String(
  VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | READ_MESSAGE_HISTORY,
);

export const DARKROOM_SCHEDULE_DROP_CUSTOM_ID_PREFIX =
  'darkroom_schedule_drop:';
export const DARKROOM_SCHEDULE_JOIN_SELECT_CUSTOM_ID = 'darkroom_schedule_join';
const DARKROOM_SCHEDULE_JOIN_CHANNEL_ID = '1512900016979837161';

const logger = createLogger('darkroom-schedule');

interface DiscordChannel {
  id: string;
  parent_id?: string | null;
  position?: number;
}

interface DiscordMessageResult {
  id?: string;
}

interface DiscordScheduleDropResponse {
  dropped?: boolean;
  message?: string;
  ok?: boolean;
  syncEvent?: DarkroomScheduleSyncInternalEvent;
  weeklyJoinMessageEvents?: DarkroomScheduleWeeklyJoinMessageInternalEvent[];
}

interface DiscordScheduleJoinResponse {
  joined?: boolean;
  message?: string;
  ok?: boolean;
  syncEvent?: DarkroomScheduleSyncInternalEvent;
  weeklyJoinMessageEvents?: DarkroomScheduleWeeklyJoinMessageInternalEvent[];
}

interface DiscordScheduleSessionActionResponse {
  action?: 'cancel' | 'end';
  message?: string;
  ok?: boolean;
  syncEvent?: DarkroomScheduleSyncInternalEvent;
  weeklyJoinMessageEvents?: DarkroomScheduleWeeklyJoinMessageInternalEvent[];
}

export function isDarkroomScheduleDropCustomId(customId: string) {
  return customId.startsWith(DARKROOM_SCHEDULE_DROP_CUSTOM_ID_PREFIX);
}

export function isDarkroomScheduleJoinSelectCustomId(customId: string) {
  return customId === DARKROOM_SCHEDULE_JOIN_SELECT_CUSTOM_ID;
}

export const DARKROOM_SCHEDULE_END_CUSTOM_ID_PREFIX = 'darkroom_schedule_end:';
export const DARKROOM_SCHEDULE_CANCEL_CUSTOM_ID_PREFIX =
  'darkroom_schedule_cancel:';

export function isDarkroomScheduleSessionActionCustomId(customId: string) {
  return (
    customId.startsWith(DARKROOM_SCHEDULE_END_CUSTOM_ID_PREFIX) ||
    customId.startsWith(DARKROOM_SCHEDULE_CANCEL_CUSTOM_ID_PREFIX)
  );
}

export async function postDarkroomWeeklyJoinMessage(
  env: Env,
  event: DarkroomScheduleWeeklyJoinMessageInternalEvent,
  options: { allowCreate?: boolean } = {},
) {
  const channelId = event.channelId ?? DARKROOM_SCHEDULE_JOIN_CHANNEL_ID;
  const payload = createWeeklyJoinMessagePayload(env, event);
  const result = await editOrSendWeeklyJoinMessage(env, {
    allowCreate: options.allowCreate === true,
    channelId,
    ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
    ...payload,
  });

  return {
    channelId,
    messageId: readMessageId(result) ?? event.messageId ?? null,
  };
}

export async function handleDarkroomScheduleDropButton(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const slotId = interaction.data.custom_id.slice(
    DARKROOM_SCHEDULE_DROP_CUSTOM_ID_PREFIX.length,
  );
  const discordId = interaction.member?.user?.id ?? interaction.user?.id;

  if (!slotId || !discordId) {
    return ephemeralResponse('I could not identify your darkroom spot.');
  }

  const result = await requestWebsiteApi(
    env,
    `/darkroom/schedule/${encodeURIComponent(slotId)}/drop-by-discord`,
    {
      body: { discordId },
      method: 'POST',
    },
  );
  const dropResponse = readDiscordScheduleDropResponse(result);

  if (dropResponse.syncEvent) {
    await syncDarkroomScheduleChannel(env, dropResponse.syncEvent);
  }
  await syncWeeklyJoinMessages(env, dropResponse.weeklyJoinMessageEvents);

  return ephemeralResponse(
    dropResponse.message ??
      (dropResponse.dropped
        ? 'You have been dropped from this darkroom timeslot.'
        : 'You were not registered for this darkroom timeslot.'),
  );
}

export async function handleDarkroomScheduleSessionActionButton(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const action = readSessionActionFromCustomId(interaction.data.custom_id);
  const slotId = readSessionSlotIdFromCustomId(interaction.data.custom_id);
  const discordId = interaction.member?.user?.id ?? interaction.user?.id;

  if (!slotId || !action || !discordId) {
    return ephemeralResponse('I could not identify this darkroom session.');
  }

  if (!hasDarkroomSessionControlRole(interaction)) {
    return ephemeralResponse(
      'Only the Executive role can end or cancel darkroom sessions.',
    );
  }

  const result = await requestWebsiteApi(
    env,
    `/darkroom/schedule/${encodeURIComponent(slotId)}/session-by-discord`,
    {
      body: { action, discordId },
      method: 'POST',
    },
  );
  const actionResponse = readDiscordScheduleSessionActionResponse(result);

  if (actionResponse.syncEvent) {
    await syncDarkroomScheduleChannel(env, actionResponse.syncEvent);
  }
  await syncWeeklyJoinMessages(env, actionResponse.weeklyJoinMessageEvents);

  return ephemeralResponse(
    actionResponse.message ??
      (action === 'cancel'
        ? 'Darkroom session cancelled and archived.'
        : 'Darkroom session ended and archived.'),
  );
}

export async function handleDarkroomScheduleJoinSelect(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const slotId = interaction.data.values?.[0];
  const discordId = interaction.member?.user?.id ?? interaction.user?.id;

  if (!slotId || !discordId) {
    return ephemeralResponse(
      'I could not identify the darkroom slot or your Discord account.',
    );
  }

  const result = await requestWebsiteApi(
    env,
    `/darkroom/schedule/${encodeURIComponent(slotId)}/join-by-discord`,
    {
      body: { discordId },
      method: 'POST',
    },
  );
  const joinResponse = readDiscordScheduleJoinResponse(result);

  if (joinResponse.syncEvent) {
    await syncDarkroomScheduleChannel(env, joinResponse.syncEvent);
  }
  await syncWeeklyJoinMessages(
    env,
    bindWeeklyJoinEventsToInteractionMessage(
      joinResponse.weeklyJoinMessageEvents,
      interaction,
    ),
  );

  return ephemeralResponse(
    joinResponse.message ??
      (joinResponse.joined
        ? 'You joined this darkroom timeslot.'
        : 'I could not join that darkroom timeslot.'),
  );
}

export async function syncDarkroomScheduleChannel(
  env: Env,
  event: DarkroomScheduleSyncInternalEvent,
) {
  if (event.deleteChannel === true) {
    return deleteScheduleChannel(env, event);
  }

  if (shouldArchiveScheduleChannel(event)) {
    return archiveScheduleChannel(env, event);
  }

  let channelId = event.channelId ?? null;
  let didCreateChannel = false;

  if (!channelId) {
    const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
    const channel = await createScheduleChannel(env, guildId, event);
    channelId = channel.id;
    didCreateChannel = true;
  }

  if (event.updateChannel === true && !didCreateChannel) {
    await updateScheduleChannel(
      env,
      channelId,
      event,
      DARKROOM_SCHEDULE_CATEGORY_ID,
    );
  }
  await reconcileSchedulePermissions(env, channelId, event);

  const messageResult = event.messageId
    ? await editOrSendScheduleMessage(env, channelId, event.messageId, event)
    : await sendScheduleMessage(env, channelId, event);

  return {
    channelId,
    messageId: readMessageId(messageResult) ?? event.messageId ?? null,
  };
}

async function deleteScheduleChannel(
  env: Env,
  event: DarkroomScheduleSyncInternalEvent,
) {
  if (!event.channelId) {
    return {
      channelId: null,
      messageId: null,
    };
  }

  try {
    await discordApiRequest(env, `/channels/${event.channelId}`, {
      method: 'DELETE',
    });
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      return {
        channelId: null,
        messageId: null,
      };
    }

    throw error;
  }

  return {
    channelId: null,
    messageId: null,
  };
}

async function archiveScheduleChannel(
  env: Env,
  event: DarkroomScheduleSyncInternalEvent,
) {
  if (!event.channelId) {
    await notifyDarkroomRegistrantsOfScheduleAction(env, event);

    return {
      channelId: null,
      messageId: event.messageId ?? null,
    };
  }

  await updateScheduleChannel(
    env,
    event.channelId,
    event,
    DARKROOM_SCHEDULE_ARCHIVE_CATEGORY_ID,
  );
  await reconcileSchedulePermissions(env, event.channelId, event);

  const messageResult = event.messageId
    ? await editOrSendScheduleMessage(
        env,
        event.channelId,
        event.messageId,
        event,
      )
    : await sendScheduleMessage(env, event.channelId, event);

  await notifyDarkroomRegistrantsOfScheduleAction(env, event);

  return {
    channelId: event.channelId,
    messageId: readMessageId(messageResult) ?? event.messageId ?? null,
  };
}

async function createScheduleChannel(
  env: Env,
  guildId: string,
  event: DarkroomScheduleSyncInternalEvent,
): Promise<DiscordChannel> {
  const channel = await discordApiRequest<DiscordChannel>(
    env,
    `/guilds/${guildId}/channels`,
    {
      body: JSON.stringify({
        name: buildScheduleChannelName(event),
        parent_id: DARKROOM_SCHEDULE_CATEGORY_ID,
        permission_overwrites: buildInitialPermissionOverwrites(guildId),
        topic: buildScheduleTopic(event),
        type: 0,
      }),
      method: 'POST',
    },
  );

  await moveChannelBelowAnchor(env, guildId, channel.id);
  return channel;
}

async function updateScheduleChannel(
  env: Env,
  channelId: string,
  event: DarkroomScheduleSyncInternalEvent,
  parentId: string,
) {
  await discordApiRequest(env, `/channels/${channelId}`, {
    body: JSON.stringify({
      name: buildScheduleChannelName(event),
      parent_id: parentId,
      topic: buildScheduleTopic(event),
    }),
    method: 'PATCH',
  });
}

async function moveChannelBelowAnchor(
  env: Env,
  guildId: string,
  channelId: string,
) {
  try {
    const channels = await discordApiRequest<DiscordChannel[]>(
      env,
      `/guilds/${guildId}/channels`,
    );
    const anchor = channels.find(
      (channel) => channel.id === DARKROOM_SCHEDULE_ANCHOR_CHANNEL_ID,
    );
    if (anchor?.position === undefined) {
      return;
    }

    await discordApiRequest(env, `/guilds/${guildId}/channels`, {
      body: JSON.stringify([
        {
          id: channelId,
          parent_id: DARKROOM_SCHEDULE_CATEGORY_ID,
          position: anchor.position + 1,
        },
      ]),
      method: 'PATCH',
    });
  } catch (error) {
    logger.warn('Failed to position darkroom schedule channel below anchor.', {
      channelId,
      error,
    });
  }
}

async function reconcileSchedulePermissions(
  env: Env,
  channelId: string,
  event: DarkroomScheduleSyncInternalEvent,
) {
  const activeDiscordIds = new Set(
    isActiveScheduleChannel(event)
      ? event.registrants.map((registrant) => registrant.discordId)
      : [],
  );
  const idsToRemove = [
    ...(event.removeDiscordIds ?? []),
    ...(!isActiveScheduleChannel(event)
      ? event.registrants.map((registrant) => registrant.discordId)
      : []),
  ].filter((discordId) => !activeDiscordIds.has(discordId));

  await Promise.all([
    ...[...activeDiscordIds].map((discordId) =>
      allowMemberInScheduleChannel(env, channelId, discordId),
    ),
    ...unique(idsToRemove).map((discordId) =>
      removeMemberFromScheduleChannel(env, channelId, discordId),
    ),
  ]);
}

async function allowMemberInScheduleChannel(
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

async function removeMemberFromScheduleChannel(
  env: Env,
  channelId: string,
  discordId: string,
) {
  try {
    await discordApiRequest(
      env,
      `/channels/${channelId}/permissions/${discordId}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      return;
    }

    throw error;
  }
}

async function sendScheduleMessage(
  env: Env,
  channelId: string,
  event: DarkroomScheduleSyncInternalEvent,
) {
  return sendDiscordMessage(env, {
    channelId,
    components: buildScheduleComponents(env, event),
    content: buildScheduleContent(event),
    embeds: [buildScheduleEmbed(event)],
  });
}

async function editScheduleMessage(
  env: Env,
  channelId: string,
  messageId: string,
  event: DarkroomScheduleSyncInternalEvent,
) {
  return editDiscordMessage(env, {
    channelId,
    components: buildScheduleComponents(env, event),
    content: buildScheduleContent(event),
    embeds: [buildScheduleEmbed(event)],
    messageId,
  });
}

async function editOrSendScheduleMessage(
  env: Env,
  channelId: string,
  messageId: string,
  event: DarkroomScheduleSyncInternalEvent,
) {
  try {
    return await editScheduleMessage(env, channelId, messageId, event);
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      return sendScheduleMessage(env, channelId, event);
    }

    throw error;
  }
}

async function editOrSendWeeklyJoinMessage(
  env: Env,
  input: {
    allowCreate: boolean;
    channelId: string;
    components?: unknown[];
    content?: string;
    embeds?: DiscordEmbed[];
    messageId?: string | null;
  },
) {
  if (!input.messageId) {
    if (!input.allowCreate) {
      logger.warn('Skipping darkroom weekly join refresh without message ID.', {
        channelId: input.channelId,
      });
      return null;
    }

    return sendDiscordMessage(env, {
      channelId: input.channelId,
      components: input.components,
      content: input.content,
      embeds: input.embeds,
    });
  }

  try {
    return await editDiscordMessage(env, {
      channelId: input.channelId,
      components: input.components,
      content: input.content,
      embeds: input.embeds,
      messageId: input.messageId,
    });
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      if (!input.allowCreate) {
        logger.warn(
          'Stored darkroom weekly join message was missing; skipping automatic replacement.',
          {
            channelId: input.channelId,
            messageId: input.messageId,
          },
        );
        return null;
      }

      logger.warn(
        'Stored darkroom weekly join message was missing; posting a replacement.',
        {
          channelId: input.channelId,
          messageId: input.messageId,
        },
      );

      return sendDiscordMessage(env, {
        channelId: input.channelId,
        components: input.components,
        content: input.content,
        embeds: input.embeds,
      });
    }

    throw error;
  }
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

function buildScheduleComponents(
  env: Env,
  event: DarkroomScheduleSyncInternalEvent,
) {
  const websiteUrl =
    getOptionalEnv(env, 'WEBSITE_URL') ?? 'https://purduephotoclub.org';
  const components = isActiveScheduleChannel(event)
    ? [
        {
          custom_id: `${DARKROOM_SCHEDULE_DROP_CUSTOM_ID_PREFIX}${event.slotId}`,
          label: 'Drop my slot',
          style: DANGER_BUTTON,
          type: BUTTON,
        },
      ]
    : [];

  return [
    {
      components: [
        ...components,
        {
          label: 'Open calendar',
          style: LINK_BUTTON,
          type: BUTTON,
          url: `${websiteUrl.replace(/\/+$/, '')}/dashboard/darkroom`,
        },
      ],
      type: ACTION_ROW,
    },
  ];
}

function createWeeklyJoinMessagePayload(
  env: Env,
  event: DarkroomScheduleWeeklyJoinMessageInternalEvent,
) {
  const websiteUrl =
    getOptionalEnv(env, 'WEBSITE_URL') ?? 'https://purduephotoclub.org';
  const calendarUrl = `${websiteUrl.replace(/\/+$/, '')}/dashboard/darkroom`;
  const joinableSlots = event.slots.filter(
    (slot) => slot.availableCapacity > 0,
  );
  const components = [
    ...(joinableSlots.length > 0
      ? [
          {
            components: [
              {
                custom_id: DARKROOM_SCHEDULE_JOIN_SELECT_CUSTOM_ID,
                max_values: 1,
                min_values: 1,
                options: joinableSlots.map(createWeeklyJoinSelectOption),
                placeholder: 'Join a darkroom timeslot',
                type: STRING_SELECT,
              },
            ],
            type: ACTION_ROW,
          },
        ]
      : []),
    {
      components: [
        {
          label: 'Open calendar',
          style: LINK_BUTTON,
          type: BUTTON,
          url: calendarUrl,
        },
      ],
      type: ACTION_ROW,
    },
  ];

  return {
    components,
    embeds: [
      {
        color: 0x60a5fa,
        description: [
          event.slots.length > 0
            ? 'Use the menu below to join an open darkroom timeslot for this week.'
            : 'No open darkroom timeslots are posted for this week yet.',
          'For private or special-case darkroom time, talk directly with the studio manager.',
          event.truncated
            ? 'Only the first 25 joinable slots can appear in Discord. Use the website calendar for the full week.'
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        fields: [
          {
            inline: false,
            name: 'Week',
            value: `${formatPlainDate(event.windowStart)} - ${formatPlainDate(event.windowEnd)}`,
          },
          {
            inline: false,
            name: 'Open slots',
            value: formatWeeklyJoinSlotList(event.slots),
          },
        ],
        footer: {
          text: 'Purdue Photography Club darkroom schedule',
        },
        title: 'Join a Darkroom Timeslot',
      },
    ],
  };
}

function createWeeklyJoinSelectOption(slot: DarkroomScheduleWeeklyJoinSlot) {
  return {
    description: truncate(
      `${formatPlainDateTime(slot.startsAt)} - ${formatPlainTime(slot.endsAt)} | ${slot.availableCapacity} open`,
      100,
    ),
    label: truncate(
      `${formatShortWeekday(slot.startsAt)} ${formatPlainTime(slot.startsAt)} - ${slot.title}`,
      100,
    ),
    value: slot.slotId,
  };
}

function formatWeeklyJoinSlotList(slots: DarkroomScheduleWeeklyJoinSlot[]) {
  if (slots.length === 0) {
    return 'No open slots yet.';
  }

  return truncate(
    slots
      .map(
        (slot) =>
          `**${formatShortWeekday(slot.startsAt)} ${formatPlainDateTime(slot.startsAt)}** - ${slot.title} (${slot.registeredCount}/${slot.capacity})`,
      )
      .join('\n'),
    1_024,
  );
}

function buildScheduleContent(event: DarkroomScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 'This darkroom timeslot has been cancelled and archived. The website calendar is the source of truth.';
  }

  if (isPastScheduleDeadline(event)) {
    return 'This darkroom timeslot has ended and the channel has been archived.';
  }

  return 'Darkroom timeslot coordination channel. Use the button below if you need to drop your spot.';
}

function buildScheduleEmbed(event: DarkroomScheduleSyncInternalEvent) {
  const startsAt = new Date(event.startsAt);
  const endsAt = new Date(event.endsAt);
  const description = getScheduleDescription(event);
  const roster =
    event.registrants.length > 0
      ? event.registrants
          .map((registrant, index) => `${index + 1}. ${registrant.name}`)
          .join('\n')
      : 'No one registered yet.';

  return {
    color: getScheduleEmbedColor(event),
    ...(description ? { description } : {}),
    fields: [
      {
        inline: true,
        name: 'Starts',
        value: formatDiscordTimestamp(startsAt),
      },
      {
        inline: true,
        name: 'Ends',
        value: formatDiscordTimestamp(endsAt),
      },
      {
        inline: true,
        name: 'Capacity',
        value: `${event.registeredCount}/${event.capacity}`,
      },
      {
        name: 'Roster',
        value: truncate(roster, 1_024),
      },
    ],
    footer: {
      text: `Darkroom schedule slot ${event.slotId}`,
    },
    timestamp: new Date().toISOString(),
    title: `${getScheduleTitlePrefix(event)}${event.title}`,
  };
}

async function notifyDarkroomRegistrantsOfScheduleAction(
  env: Env,
  event: DarkroomScheduleSyncInternalEvent,
) {
  if (!event.notificationAction || event.registrants.length === 0) {
    return;
  }

  const discordIds = unique(
    event.registrants.flatMap((registrant) => {
      const discordId = registrant.discordId.trim();
      return discordId.length > 0 ? [discordId] : [];
    }),
  );

  await Promise.all(
    discordIds.map(async (discordId) => {
      try {
        await sendDiscordDirectMessage(env, {
          content: buildDarkroomScheduleActionDmContent(event),
          recipientId: discordId,
        });
      } catch (error) {
        logger.warn('Failed to send darkroom schedule action DM.', {
          error,
          slotId: event.slotId,
          notificationAction: event.notificationAction,
          recipientId: discordId,
        });
      }
    }),
  );
}

function buildDarkroomScheduleActionDmContent(
  event: DarkroomScheduleSyncInternalEvent,
) {
  const action = event.notificationAction === 'cancel' ? 'cancelled' : 'ended';

  return [
    `Your darkroom session for ${formatPlainDateTime(event.startsAt)} - ${formatPlainTime(event.endsAt)} was ${action}.`,
    '',
    'Open the darkroom calendar if you need to join another session.',
  ].join('\n');
}

function buildScheduleChannelName(event: DarkroomScheduleSyncInternalEvent) {
  const startsAt = new Date(event.startsAt);
  const weekday = startsAt
    .toLocaleString('en-US', {
      weekday: 'short',
      timeZone: 'America/Indiana/Indianapolis',
    })
    .toLowerCase();
  const month = startsAt
    .toLocaleString('en-US', {
      month: 'short',
      timeZone: 'America/Indiana/Indianapolis',
    })
    .toLowerCase();
  const day = startsAt.toLocaleString('en-US', {
    day: '2-digit',
    timeZone: 'America/Indiana/Indianapolis',
  });
  const hour = startsAt
    .toLocaleString('en-US', {
      hour: 'numeric',
      hour12: true,
      timeZone: 'America/Indiana/Indianapolis',
    })
    .toLowerCase()
    .replace(/\s/g, '');
  const prefix = getScheduleChannelPrefix(event);

  return sanitizeChannelName(
    `${prefix}-${weekday}-${month}-${day}-${hour}-${event.title}`,
  );
}

function buildScheduleTopic(event: DarkroomScheduleSyncInternalEvent) {
  return truncate(
    [
      `${event.title}: ${formatPlainDateTime(event.startsAt)} - ${formatPlainDateTime(event.endsAt)}`,
      `Capacity ${event.registeredCount}/${event.capacity}`,
      getScheduleTopicStatus(event),
    ]
      .filter(Boolean)
      .join(' | '),
    1_024,
  );
}

function shouldArchiveScheduleChannel(
  event: DarkroomScheduleSyncInternalEvent,
) {
  return event.status === 'cancelled' || isPastScheduleDeadline(event);
}

function isActiveScheduleChannel(event: DarkroomScheduleSyncInternalEvent) {
  return !shouldArchiveScheduleChannel(event);
}

function isPastScheduleDeadline(event: DarkroomScheduleSyncInternalEvent) {
  return Date.parse(event.endsAt) <= Date.now();
}

function getScheduleDescription(event: DarkroomScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 'Cancelled slots are moved into the darkroom archive category.';
  }

  if (isPastScheduleDeadline(event)) {
    return 'Past slots are moved into the darkroom archive category.';
  }

  return null;
}

function getScheduleEmbedColor(event: DarkroomScheduleSyncInternalEvent) {
  if (event.status === 'cancelled' || isPastScheduleDeadline(event)) {
    return 0xf85149;
  }

  return 0x58a6ff;
}

function getScheduleTitlePrefix(event: DarkroomScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 'Cancelled: ';
  }

  return isPastScheduleDeadline(event) ? 'Archived: ' : '';
}

function getScheduleChannelPrefix(event: DarkroomScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 'cancelled';
  }

  return isPastScheduleDeadline(event) ? 'past' : 'darkroom';
}

function getScheduleTopicStatus(event: DarkroomScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 'Cancelled and archived';
  }

  return isPastScheduleDeadline(event) ? 'Ended and archived' : 'Active';
}

function readDiscordScheduleDropResponse(
  value: unknown,
): DiscordScheduleDropResponse {
  if (!isRecord(value) || value.ok !== true) {
    throw new BadRequestError(
      'Website API returned an invalid darkroom drop response.',
    );
  }

  return {
    dropped: value.dropped === true,
    ok: true,
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(isDarkroomScheduleSyncEvent(value.syncEvent)
      ? { syncEvent: value.syncEvent }
      : {}),
    weeklyJoinMessageEvents: readWeeklyJoinMessageEvents(
      value.weeklyJoinMessageEvents,
    ),
  };
}

function readDiscordScheduleSessionActionResponse(
  value: unknown,
): DiscordScheduleSessionActionResponse {
  if (!isRecord(value) || value.ok !== true) {
    throw new BadRequestError(
      'Website API returned an invalid darkroom session response.',
    );
  }

  const action =
    value.action === 'cancel' || value.action === 'end'
      ? value.action
      : undefined;

  return {
    ...(action ? { action } : {}),
    ok: true,
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(isDarkroomScheduleSyncEvent(value.syncEvent)
      ? { syncEvent: value.syncEvent }
      : {}),
    weeklyJoinMessageEvents: readWeeklyJoinMessageEvents(
      value.weeklyJoinMessageEvents,
    ),
  };
}

function readDiscordScheduleJoinResponse(
  value: unknown,
): DiscordScheduleJoinResponse {
  if (!isRecord(value) || value.ok !== true) {
    throw new BadRequestError(
      'Website API returned an invalid darkroom join response.',
    );
  }

  return {
    joined: value.joined === true,
    ok: true,
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(isDarkroomScheduleSyncEvent(value.syncEvent)
      ? { syncEvent: value.syncEvent }
      : {}),
    weeklyJoinMessageEvents: readWeeklyJoinMessageEvents(
      value.weeklyJoinMessageEvents,
    ),
  };
}

async function syncWeeklyJoinMessages(
  env: Env,
  events: DarkroomScheduleWeeklyJoinMessageInternalEvent[] | undefined,
) {
  await Promise.all(
    (events ?? []).flatMap((event) => {
      if (!event.messageId) {
        logger.warn(
          'Skipping darkroom weekly join refresh without message ID.',
          {
            channelId: event.channelId,
            windowStart: event.windowStart,
          },
        );
        return [];
      }

      return [
        postDarkroomWeeklyJoinMessage(env, event, { allowCreate: false }),
      ];
    }),
  );
}

function bindWeeklyJoinEventsToInteractionMessage(
  events: DarkroomScheduleWeeklyJoinMessageInternalEvent[] | undefined,
  interaction: ComponentInteraction,
): DarkroomScheduleWeeklyJoinMessageInternalEvent[] | undefined {
  const sourceMessageId = interaction.message?.id;
  if (!sourceMessageId || !events || events.length === 0) {
    return events;
  }

  const sourceChannelId = interaction.channel_id;
  const fallbackEvent = events[0];
  if (!fallbackEvent) {
    return [];
  }

  const sourceEvent =
    events.find((event) => event.messageId === sourceMessageId) ??
    events.find(
      (event) => sourceChannelId && event.channelId === sourceChannelId,
    ) ??
    fallbackEvent;
  const boundEvent: DarkroomScheduleWeeklyJoinMessageInternalEvent = {
    ...sourceEvent,
    ...(sourceChannelId ? { channelId: sourceChannelId } : {}),
    messageId: sourceMessageId,
  };

  return [boundEvent];
}

function readWeeklyJoinMessageEvents(
  value: unknown,
): DarkroomScheduleWeeklyJoinMessageInternalEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isDarkroomWeeklyJoinMessageEvent);
}

function readSessionActionFromCustomId(
  customId: string,
): 'cancel' | 'end' | null {
  if (customId.startsWith(DARKROOM_SCHEDULE_END_CUSTOM_ID_PREFIX)) {
    return 'end';
  }

  if (customId.startsWith(DARKROOM_SCHEDULE_CANCEL_CUSTOM_ID_PREFIX)) {
    return 'cancel';
  }

  return null;
}

function readSessionSlotIdFromCustomId(customId: string) {
  if (customId.startsWith(DARKROOM_SCHEDULE_END_CUSTOM_ID_PREFIX)) {
    return customId.slice(DARKROOM_SCHEDULE_END_CUSTOM_ID_PREFIX.length);
  }

  if (customId.startsWith(DARKROOM_SCHEDULE_CANCEL_CUSTOM_ID_PREFIX)) {
    return customId.slice(DARKROOM_SCHEDULE_CANCEL_CUSTOM_ID_PREFIX.length);
  }

  return '';
}

function hasDarkroomSessionControlRole(interaction: ComponentInteraction) {
  const roles = interaction.member?.roles ?? [];
  return (
    roles.includes(DISCORD_ROLE_IDS.executive) ||
    roles.includes(DISCORD_ROLE_IDS.admin)
  );
}

function isDarkroomWeeklyJoinMessageEvent(
  value: unknown,
): value is DarkroomScheduleWeeklyJoinMessageInternalEvent {
  return (
    isRecord(value) &&
    value.type === 'website.darkroom.schedule.weekly_join_message' &&
    typeof value.windowStart === 'string' &&
    typeof value.windowEnd === 'string' &&
    Array.isArray(value.slots)
  );
}

function isDarkroomScheduleSyncEvent(
  value: unknown,
): value is DarkroomScheduleSyncInternalEvent {
  return (
    isRecord(value) &&
    value.type === 'website.darkroom.schedule.sync' &&
    typeof value.slotId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.startsAt === 'string' &&
    typeof value.endsAt === 'string' &&
    typeof value.capacity === 'number' &&
    typeof value.registeredCount === 'number' &&
    Array.isArray(value.registrants) &&
    (value.status === 'open' || value.status === 'cancelled')
  );
}

function readMessageId(result: unknown) {
  if (!isRecord(result)) {
    return null;
  }

  const message = result as DiscordMessageResult;
  return typeof message.id === 'string' ? message.id : null;
}

function formatDiscordTimestamp(date: Date) {
  return `<t:${Math.floor(date.getTime() / 1_000)}:f>`;
}

function formatPlainDateTime(value: string) {
  return new Date(value).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Indiana/Indianapolis',
  });
}

function formatPlainDate(value: string) {
  return new Date(value).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'America/Indiana/Indianapolis',
  });
}

function formatPlainTime(value: string) {
  return new Date(value).toLocaleTimeString('en-US', {
    hour: 'numeric',
    hour12: true,
    minute: '2-digit',
    timeZone: 'America/Indiana/Indianapolis',
  });
}

function formatShortWeekday(value: string) {
  return new Date(value).toLocaleDateString('en-US', {
    timeZone: 'America/Indiana/Indianapolis',
    weekday: 'short',
  });
}

function sanitizeChannelName(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'darkroom-slot'
  );
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function unique(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
