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
import { requestWebsiteApi } from './websiteApiService';
import { BadRequestError, DiscordApiError } from '../utils/errors';
import { getOptionalEnv, getRequiredEnv } from '../utils/env';
import { createLogger } from '../utils/logger';
import {
  editDiscordMessage,
  sendDiscordDirectMessage,
  sendDiscordMessage,
} from './discordMessageService';
import {
  addManagedPrivateThreadMember,
  assertManagedPrivateThread,
  createManagedPrivateThread,
  deleteDiscordManagedChannel,
  findManagedPrivateThread,
  getDiscordManagedChannel,
  isDiscordPrivateThread,
  prepareManagedPrivateThread,
  removeManagedPrivateThreadMember,
  type DiscordManagedChannel,
  type ManagedPrivateThreadSpec,
} from './discordPrivateThreadService';

const DARKROOM_SCHEDULE_CATEGORY_ID = '1512506913043124436';
const DARKROOM_SCHEDULE_ARCHIVE_CATEGORY_ID = '1512863825735585943';
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const DANGER_BUTTON = 4;
const LINK_BUTTON = 5;

export const DARKROOM_SCHEDULE_DROP_CUSTOM_ID_PREFIX =
  'darkroom_schedule_drop:';
export const DARKROOM_SCHEDULE_JOIN_SELECT_CUSTOM_ID = 'darkroom_schedule_join';
const DARKROOM_SCHEDULE_JOIN_CHANNEL_ID = '1512900016979837161';

const logger = createLogger('darkroom-schedule');

type DiscordChannel = DiscordManagedChannel;

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

interface DiscordScheduleSyncResultResponse {
  ok: true;
  stale: boolean;
  syncEvent?: DarkroomScheduleSyncInternalEvent;
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
const DARKROOM_DISCORD_MUTATION_CONCURRENCY = 2;

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
  if (channelId !== DARKROOM_SCHEDULE_JOIN_CHANNEL_ID) {
    throw new BadRequestError(
      'Darkroom weekly message channel is not allowed.',
    );
  }
  const payload = createWeeklyJoinMessagePayload(env, event);
  const result = await editOrSendWeeklyJoinMessage(env, {
    allowCreate: options.allowCreate === true,
    channelId,
    nonce: buildDarkroomWeeklyMessageNonce(event),
    ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
    ...payload,
  });

  return {
    channelId,
    messageId:
      result === null
        ? null
        : (readMessageId(result) ?? event.messageId ?? null),
    ok: result !== null,
    stale: result === null && !!event.messageId,
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

  const syncWarning = await syncDarkroomInteractionState(env, {
    syncEvent: dropResponse.syncEvent,
    weeklyJoinMessageEvents: dropResponse.weeklyJoinMessageEvents,
  });

  return ephemeralResponse(
    appendDarkroomSyncWarning(
      dropResponse.message ??
        (dropResponse.dropped
          ? 'You have been dropped from this darkroom timeslot.'
          : 'You were not registered for this darkroom timeslot.'),
      syncWarning,
    ),
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

  const result = await requestWebsiteApi(
    env,
    `/darkroom/schedule/${encodeURIComponent(slotId)}/session-by-discord`,
    {
      body: { action, discordId },
      method: 'POST',
    },
  );
  const actionResponse = readDiscordScheduleSessionActionResponse(result);

  const syncWarning = await syncDarkroomInteractionState(env, {
    syncEvent: actionResponse.syncEvent,
    weeklyJoinMessageEvents: actionResponse.weeklyJoinMessageEvents,
  });

  return ephemeralResponse(
    appendDarkroomSyncWarning(
      actionResponse.message ??
        (action === 'cancel'
          ? 'Darkroom session cancelled and its private thread was deleted.'
          : 'Darkroom session ended and its private thread was deleted.'),
      syncWarning,
    ),
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

  const syncWarning = await syncDarkroomInteractionState(env, {
    syncEvent: joinResponse.syncEvent,
    weeklyJoinMessageEvents: bindWeeklyJoinEventsToInteractionMessage(
      joinResponse.weeklyJoinMessageEvents,
      interaction,
    ),
  });

  return ephemeralResponse(
    appendDarkroomSyncWarning(
      joinResponse.message ??
        (joinResponse.joined
          ? 'You joined this darkroom timeslot.'
          : 'I could not join that darkroom timeslot.'),
      syncWarning,
    ),
  );
}

export async function syncDarkroomScheduleChannel(
  env: Env,
  event: DarkroomScheduleSyncInternalEvent,
) {
  let syncEvent = event;
  let legacyChannelId: string | null = null;
  let thread: DiscordManagedChannel | null = null;
  let threadAllowsMissingOwner = false;

  await assertDarkroomScheduleSyncEventCurrent(env, event, {
    allowArchived: shouldDeleteScheduleRoom(event),
  });

  if (event.channelId) {
    const room = await resolveDarkroomScheduleRoom(env, event.channelId, event);
    if (!room) {
      syncEvent = { ...event, channelId: null, messageId: null };
    } else if (room.kind === 'thread') {
      thread = room.channel;
      threadAllowsMissingOwner = true;
    } else {
      legacyChannelId = room.channel.id;
      syncEvent = { ...event, channelId: null, messageId: null };
    }
  }

  if (!thread && !syncEvent.channelId) {
    thread = await findManagedPrivateThread(
      env,
      getDarkroomThreadSpec(syncEvent),
    );
  }

  if (!thread && !legacyChannelId && !syncEvent.channelId) {
    const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
    const existingChannel = await findExistingScheduleChannel(
      env,
      guildId,
      syncEvent,
    );
    if (existingChannel) {
      await assertLegacyDarkroomScheduleChannelOwnership(
        env,
        existingChannel,
        syncEvent,
      );
      legacyChannelId = existingChannel.id;
    }
  }

  if (shouldDeleteScheduleRoom(syncEvent)) {
    await notifyDarkroomRegistrantsOfScheduleAction(env, syncEvent);
    const channelId = thread?.id ?? legacyChannelId;
    if (channelId) {
      await deleteDiscordManagedChannel(env, channelId);
    }
    return {
      channelId: null,
      messageId: null,
    };
  }

  const threadSpec = getDarkroomThreadSpec(syncEvent);
  let didCreateThread = false;
  if (!thread) {
    thread = await createManagedPrivateThread(
      env,
      buildScheduleChannelName(syncEvent),
      threadSpec,
    );
    didCreateThread = true;
  } else {
    thread = await prepareManagedPrivateThread(
      env,
      thread,
      buildScheduleChannelName(syncEvent),
      threadSpec,
      { allowMissingOwner: threadAllowsMissingOwner },
    );
  }

  try {
    if (didCreateThread) {
      await assertDarkroomScheduleSyncEventCurrent(env, syncEvent);
    }
    await reconcileScheduleThreadMembers(env, thread.id, syncEvent);
    const messageResult = syncEvent.messageId
      ? await editOrSendScheduleMessage(
          env,
          thread.id,
          syncEvent.messageId,
          syncEvent,
        )
      : await sendScheduleMessage(env, thread.id, syncEvent);

    if (legacyChannelId) {
      await deleteDiscordManagedChannel(env, legacyChannelId);
    }

    return {
      channelId: thread.id,
      messageId: readMessageId(messageResult) ?? syncEvent.messageId ?? null,
    };
  } catch (error) {
    if (didCreateThread) {
      try {
        await deleteDiscordManagedChannel(env, thread.id);
      } catch (rollbackError) {
        logger.warn('Failed to roll back a partial darkroom private thread.', {
          error: rollbackError,
          slotId: syncEvent.slotId,
          threadId: thread.id,
        });
      }
    }
    throw error;
  }
}

async function assertDarkroomScheduleSyncEventCurrent(
  env: Env,
  event: DarkroomScheduleSyncInternalEvent,
  options: { allowArchived?: boolean } = {},
) {
  const state = await requestWebsiteApi(
    env,
    `/darkroom/schedule/${encodeURIComponent(event.slotId)}/discord-sync-state`,
  );
  if (
    !isRecord(state) ||
    state.status !== event.status ||
    state.syncRevision !== event.syncRevision ||
    (state.discordSyncStatus !== 'pending' &&
      state.discordSyncStatus !== 'synced' &&
      state.discordSyncStatus !== 'failed' &&
      !(options.allowArchived && state.discordSyncStatus === 'archived'))
  ) {
    throw new BadRequestError('Darkroom Discord sync event is stale.');
  }
}

async function findExistingScheduleChannel(
  env: Env,
  guildId: string,
  event: DarkroomScheduleSyncInternalEvent,
) {
  const channels = await discordApiRequest<DiscordChannel[]>(
    env,
    `/guilds/${guildId}/channels`,
  );
  const markerPrefix = `${buildScheduleTopicOwnershipMarker(event)};REV=`;
  return (
    channels.find(
      (channel) =>
        (channel.type === 0 || channel.type === undefined) &&
        channel.topic?.split(' | ').at(-1)?.startsWith(markerPrefix) === true &&
        (channel.parent_id === DARKROOM_SCHEDULE_CATEGORY_ID ||
          channel.parent_id === DARKROOM_SCHEDULE_ARCHIVE_CATEGORY_ID),
    ) ?? null
  );
}

async function resolveDarkroomScheduleRoom(
  env: Env,
  channelId: string,
  event: DarkroomScheduleSyncInternalEvent,
) {
  const channel = await getDiscordManagedChannel(env, channelId);
  if (!channel) {
    return null;
  }
  if (isDiscordPrivateThread(channel)) {
    assertManagedPrivateThread(env, channel, getDarkroomThreadSpec(event), {
      allowMissingOwner: true,
    });
    return { channel, kind: 'thread' as const };
  }

  await assertLegacyDarkroomScheduleChannelOwnership(env, channel, event);
  return { channel, kind: 'legacy' as const };
}

async function assertLegacyDarkroomScheduleChannelOwnership(
  env: Env,
  channel: DiscordChannel,
  event: DarkroomScheduleSyncInternalEvent,
) {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const isAllowedCategory =
    channel.parent_id === DARKROOM_SCHEDULE_CATEGORY_ID ||
    channel.parent_id === DARKROOM_SCHEDULE_ARCHIVE_CATEGORY_ID;
  const markerPrefix = `${buildScheduleTopicOwnershipMarker(event)};REV=`;
  if (
    channel.guild_id !== guildId ||
    (channel.type !== 0 && channel.type !== undefined) ||
    !isAllowedCategory ||
    !channel.topic
  ) {
    throw new BadRequestError('Darkroom schedule channel ownership mismatch.');
  }

  const terminalMarker = channel.topic.split(' | ').at(-1);
  if (terminalMarker?.startsWith(markerPrefix)) {
    const storedRevision = Number(terminalMarker.slice(markerPrefix.length));
    if (
      !Number.isInteger(storedRevision) ||
      storedRevision > event.syncRevision
    ) {
      throw new BadRequestError('Darkroom schedule event is stale.');
    }
    return true;
  }

  const legacyPrefix = `${event.title}: ${formatPlainDateTime(event.startsAt)} - ${formatPlainDateTime(event.endsAt)} | Capacity `;
  if (!channel.topic.startsWith(legacyPrefix)) {
    throw new BadRequestError('Darkroom schedule channel marker mismatch.');
  }

  await discordApiRequest(env, `/channels/${channel.id}`, {
    body: JSON.stringify({ topic: buildScheduleTopic(event) }),
    method: 'PATCH',
  });
}

async function reconcileScheduleThreadMembers(
  env: Env,
  threadId: string,
  event: DarkroomScheduleSyncInternalEvent,
) {
  const activeDiscordIds = new Set(
    isActiveScheduleChannel(event)
      ? [
          ...event.registrants.map((registrant) => registrant.discordId),
          ...(event.managerDiscordIds ?? []),
        ]
      : [],
  );
  const idsToRemove = [
    ...(event.removeDiscordIds ?? []),
    ...(event.removeManagerDiscordIds ?? []),
    ...(!isActiveScheduleChannel(event)
      ? event.registrants.map((registrant) => registrant.discordId)
      : []),
  ].filter((discordId) => !activeDiscordIds.has(discordId));

  const changes = [
    ...[...activeDiscordIds].map((discordId) => ({
      action: 'allow' as const,
      discordId,
    })),
    ...unique(idsToRemove).map((discordId) => ({
      action: 'remove' as const,
      discordId,
    })),
  ];

  await runWithConcurrency(
    changes,
    DARKROOM_DISCORD_MUTATION_CONCURRENCY,
    (change) =>
      change.action === 'allow'
        ? addManagedPrivateThreadMember(env, threadId, change.discordId)
        : removeManagedPrivateThreadMember(env, threadId, change.discordId),
  );
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
    nonce: buildDarkroomScheduleMessageNonce(event),
  });
}

function buildDarkroomScheduleMessageNonce(
  event: DarkroomScheduleSyncInternalEvent,
) {
  return `dr-slot-${event.slotId.slice(-16)}`;
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
    nonce: string;
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
      nonce: input.nonce,
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
        nonce: input.nonce,
      });
    }

    throw error;
  }
}

function buildDarkroomWeeklyMessageNonce(
  event: DarkroomScheduleWeeklyJoinMessageInternalEvent,
) {
  return `dr-week-${Math.floor(Date.parse(event.windowStart) / 1_000).toString(36)}`;
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
        {
          custom_id: `${DARKROOM_SCHEDULE_END_CUSTOM_ID_PREFIX}${event.slotId}`,
          label: 'End Session',
          style: DANGER_BUTTON,
          type: BUTTON,
        },
        {
          custom_id: `${DARKROOM_SCHEDULE_CANCEL_CUSTOM_ID_PREFIX}${event.slotId}`,
          label: 'Cancel Session',
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
    return 'This darkroom timeslot was cancelled and its private thread was deleted. The website calendar is the source of truth.';
  }

  if (isPastScheduleDeadline(event)) {
    return 'This darkroom timeslot ended and its private thread was deleted.';
  }

  return 'Darkroom timeslot coordination thread. Use the button below if you need to drop your spot.';
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

  await runWithConcurrency(
    discordIds,
    DARKROOM_DISCORD_MUTATION_CONCURRENCY,
    async (discordId) => {
      try {
        await sendDiscordDirectMessage(env, {
          content: buildDarkroomScheduleActionDmContent(event),
          nonce: buildDarkroomScheduleActionDmNonce(event, discordId),
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
    },
  );
}

async function runWithConcurrency<Item>(
  items: readonly Item[],
  concurrency: number,
  operation: (item: Item) => Promise<unknown>,
) {
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async (_, workerIndex) => {
      for (
        let itemIndex = workerIndex;
        itemIndex < items.length;
        itemIndex += workerCount
      ) {
        await operation(items[itemIndex] as Item);
      }
    }),
  );
}

function buildDarkroomScheduleActionDmNonce(
  event: DarkroomScheduleSyncInternalEvent,
  discordId: string,
) {
  const action = event.notificationAction === 'cancel' ? 'c' : 'e';
  return `drd-${action}-${event.slotId.slice(-8)}-${discordId.slice(-8)}`;
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

function getDarkroomThreadSpec(
  event: DarkroomScheduleSyncInternalEvent,
): ManagedPrivateThreadSpec {
  return {
    marker: `--pcc-darkroom-${event.slotId}`,
    parentChannelId: DARKROOM_SCHEDULE_JOIN_CHANNEL_ID,
    syncRevision: event.syncRevision,
  };
}

function buildScheduleTopic(event: DarkroomScheduleSyncInternalEvent) {
  const marker = buildScheduleTopicMarker(event);
  const details = [
    `${event.title}: ${formatPlainDateTime(event.startsAt)} - ${formatPlainDateTime(event.endsAt)}`,
    `Capacity ${event.registeredCount}/${event.capacity}`,
    getScheduleTopicStatus(event),
  ]
    .filter(Boolean)
    .join(' | ');
  return `${truncate(details, 1_024 - marker.length - 3)} | ${marker}`;
}

function buildScheduleTopicMarker(event: DarkroomScheduleSyncInternalEvent) {
  return `${buildScheduleTopicOwnershipMarker(event)};REV=${event.syncRevision}`;
}

function buildScheduleTopicOwnershipMarker(
  event: DarkroomScheduleSyncInternalEvent,
) {
  return `PCC_DARKROOM_SLOT=${event.slotId}`;
}

function shouldDeleteScheduleRoom(event: DarkroomScheduleSyncInternalEvent) {
  return (
    event.deleteChannel === true ||
    event.status === 'cancelled' ||
    isPastScheduleDeadline(event)
  );
}

function isActiveScheduleChannel(event: DarkroomScheduleSyncInternalEvent) {
  return !shouldDeleteScheduleRoom(event);
}

function isPastScheduleDeadline(event: DarkroomScheduleSyncInternalEvent) {
  return Date.parse(event.endsAt) <= Date.now();
}

function getScheduleDescription(event: DarkroomScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 'Cancelled slots are closed and their private threads are deleted.';
  }

  if (isPastScheduleDeadline(event)) {
    return 'Past slots are closed and their private threads are deleted.';
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

  return isPastScheduleDeadline(event) ? 'Ended: ' : '';
}

function getScheduleChannelPrefix(event: DarkroomScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 'cancelled';
  }

  return isPastScheduleDeadline(event) ? 'past' : 'darkroom';
}

function getScheduleTopicStatus(event: DarkroomScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 'Cancelled';
  }

  return isPastScheduleDeadline(event) ? 'Ended' : 'Active';
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
  const results = await Promise.all(
    (events ?? []).map((event) => {
      if (!event.messageId) {
        logger.warn(
          'Skipping darkroom weekly join refresh without message ID.',
          {
            channelId: event.channelId,
            windowStart: event.windowStart,
          },
        );
        return Promise.reject(
          new Error('Darkroom weekly refresh is missing its message ID.'),
        );
      }

      return postDarkroomWeeklyJoinMessage(env, event, {
        allowCreate: false,
      });
    }),
  );
  if (results.some((result) => result.ok !== true)) {
    throw new Error(
      'One or more darkroom weekly messages could not be refreshed.',
    );
  }
}

async function syncDarkroomInteractionState(
  env: Env,
  input: {
    syncEvent?: DarkroomScheduleSyncInternalEvent | undefined;
    weeklyJoinMessageEvents?:
      | DarkroomScheduleWeeklyJoinMessageInternalEvent[]
      | undefined;
  },
) {
  // Component interactions have a short acknowledgement window. Keep these
  // independent views concurrent; longer rate-limit waits are scoped to the
  // authenticated internal scheduling route instead.
  const results = await Promise.allSettled([
    ...(input.syncEvent
      ? [syncDarkroomScheduleAndPersist(env, input.syncEvent)]
      : []),
    syncWeeklyJoinMessages(env, input.weeklyJoinMessageEvents),
  ]);
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length === 0) return false;

  logger.warn(
    'Darkroom interaction saved but Discord views did not fully sync.',
    {
      failedSyncs: failed.length,
    },
  );
  return true;
}

async function syncDarkroomScheduleAndPersist(
  env: Env,
  event: DarkroomScheduleSyncInternalEvent,
) {
  const result = await syncDarkroomScheduleChannel(env, event);
  const persisted = await persistDarkroomScheduleSyncResult(env, event, result);
  const latestEvent = persisted.syncEvent;
  if (!persisted.stale || !latestEvent) {
    return result;
  }

  if (
    latestEvent.slotId !== event.slotId ||
    latestEvent.syncRevision <= event.syncRevision
  ) {
    throw new BadRequestError(
      'Website API returned an invalid darkroom convergence event.',
    );
  }

  // A drop can commit just before a rejoin increments the revision. If the old
  // Discord mutation wins the race, repair exactly once from the API-authored
  // latest event so the member list converges without an unbounded callback
  // loop.
  const repaired = await syncDarkroomScheduleChannel(env, latestEvent);
  const repairedPersistence = await persistDarkroomScheduleSyncResult(
    env,
    latestEvent,
    repaired,
  );
  if (repairedPersistence.stale) {
    logger.warn('Darkroom convergence raced with another schedule revision.', {
      slotId: latestEvent.slotId,
      syncRevision: latestEvent.syncRevision,
    });
  }
  return repaired;
}

async function persistDarkroomScheduleSyncResult(
  env: Env,
  event: DarkroomScheduleSyncInternalEvent,
  result: { channelId: string | null; messageId: string | null },
): Promise<DiscordScheduleSyncResultResponse> {
  const response = await requestWebsiteApi(
    env,
    `/darkroom/schedule/${encodeURIComponent(event.slotId)}/sync-result-by-discord`,
    {
      body: {
        channelId: result.channelId,
        deleted: event.deleteChannel === true,
        messageId: result.messageId,
        removeManagerDiscordIds: event.removeManagerDiscordIds ?? [],
        syncRevision: event.syncRevision,
      },
      method: 'POST',
    },
  );
  if (
    !isRecord(response) ||
    response.ok !== true ||
    typeof response.stale !== 'boolean'
  ) {
    throw new BadRequestError(
      'Website API returned an invalid darkroom sync result.',
    );
  }

  return {
    ok: true,
    stale: response.stale,
    ...(isDarkroomScheduleSyncEvent(response.syncEvent)
      ? { syncEvent: response.syncEvent }
      : {}),
  };
}

function appendDarkroomSyncWarning(message: string, hasWarning: boolean) {
  return hasWarning
    ? `${message} Some Discord views may take a moment to catch up.`
    : message;
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
  const sourceEvent =
    events.find((event) => event.messageId === sourceMessageId) ??
    events.find(
      (event) => sourceChannelId && event.channelId === sourceChannelId,
    ) ??
    (events.length === 1 ? events[0] : undefined);
  if (!sourceEvent) return events;

  const boundEvent: DarkroomScheduleWeeklyJoinMessageInternalEvent = {
    ...sourceEvent,
    ...(sourceChannelId ? { channelId: sourceChannelId } : {}),
    messageId: sourceMessageId,
  };

  return events.map((event) => (event === sourceEvent ? boundEvent : event));
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
