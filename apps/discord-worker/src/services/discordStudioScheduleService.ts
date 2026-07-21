import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import { discordApiRequest } from '../discord/api';
import { ephemeralResponse } from '../discord/responses';
import type {
  ComponentInteraction,
  DiscordEmbed,
  DiscordInteractionResponse,
  Env,
  ModalSubmitInteraction,
} from '../discord/types';
import { InteractionResponseType } from 'discord-interactions';
import type {
  StudioPendingReviewInternalEvent,
  StudioScheduleMessageInternalEvent,
  StudioScheduleSyncInternalEvent,
} from '../internal-events/types';
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
  type DiscordManagedChannel,
  type ManagedPrivateThreadSpec,
} from './discordPrivateThreadService';
import { requestWebsiteApi } from './websiteApiService';
import { BadRequestError, DiscordApiError } from '../utils/errors';
import { getOptionalEnv, getRequiredEnv } from '../utils/env';
import { createLogger } from '../utils/logger';

const STUDIO_SCHEDULE_CATEGORY_ID = '1512506777650856016';
const STUDIO_RESOLVED_CATEGORY_ID = '1512863825735585943';
const STUDIO_SCHEDULE_CHANNEL_ID = '1513286980518023348';
const STUDIO_PENDING_REVIEW_CHANNEL_ID = '1513603798029828218';
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const INPUT_TEXT = 4;
const LABEL = 18;
const CHECKBOX = 23;
const SHORT_TEXT = 1;
const PARAGRAPH_TEXT = 2;
const PRIMARY_BUTTON = 1;
const SUCCESS_BUTTON = 3;
const DANGER_BUTTON = 4;
const LINK_BUTTON = 5;

const logger = createLogger('studio-schedule');

export const STUDIO_SCHEDULE_BOOK_CUSTOM_ID = 'studio_schedule_book';
export const STUDIO_BOOKING_MODAL_CUSTOM_ID = 'studio_schedule_request_modal';
export const STUDIO_CANCEL_NEXT_CUSTOM_ID = 'studio_cancel_next';
export const STUDIO_CANCEL_CUSTOM_ID_PREFIX = 'studio_cancel:';
export const STUDIO_CANCEL_MODAL_CUSTOM_ID = 'studio_cancel_modal';
export const STUDIO_REVIEW_CUSTOM_ID_PREFIX = 'studio_review:';
export const STUDIO_REVIEW_MODAL_CUSTOM_ID_PREFIX = 'studio_review_modal:';
const STUDIO_REQUEST_DATE_CUSTOM_ID = 'studio_request_date';
const STUDIO_REQUEST_START_TIME_CUSTOM_ID = 'studio_request_start_time';
const STUDIO_REQUEST_END_TIME_CUSTOM_ID = 'studio_request_end_time';
const STUDIO_REQUEST_MANAGER_HELP_CUSTOM_ID = 'studio_request_manager_help';
const STUDIO_REQUEST_NOTE_CUSTOM_ID = 'studio_request_note';
const STUDIO_CANCEL_REQUEST_CUSTOM_ID = 'studio_cancel_request';
const STUDIO_REVIEW_NOTE_CUSTOM_ID = 'studio_review_note';

type DiscordChannel = DiscordManagedChannel;

interface DiscordMessageResult {
  id?: string;
}

interface WebsiteStudioActionResponse {
  message?: string;
  ok?: boolean;
}

interface WebsiteStudioCancellableRequest {
  endsAt: string;
  id: string;
  startsAt: string;
  status: string;
}

interface WebsiteStudioCancellableResponse {
  message?: string;
  ok?: boolean;
  requests: WebsiteStudioCancellableRequest[];
}

type ModalValue = boolean | string | string[];

export function isStudioScheduleBookCustomId(customId: string) {
  return customId === STUDIO_SCHEDULE_BOOK_CUSTOM_ID;
}

export function isStudioReviewButtonCustomId(customId: string) {
  return parseStudioReviewCustomId(customId) !== null;
}

export function isStudioCancelButtonCustomId(customId: string) {
  return (
    customId === STUDIO_CANCEL_NEXT_CUSTOM_ID ||
    parseStudioCancelCustomId(customId) !== null
  );
}

export function isStudioModalCustomId(customId: string) {
  return (
    customId === STUDIO_BOOKING_MODAL_CUSTOM_ID ||
    customId === STUDIO_CANCEL_MODAL_CUSTOM_ID ||
    parseStudioReviewModalCustomId(customId) !== null
  );
}

export function handleStudioScheduleBookButton(): DiscordInteractionResponse {
  return {
    data: createStudioBookingModalPayload(),
    type: InteractionResponseType.MODAL,
  };
}

export async function handleStudioCancelButton(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const requestId = parseStudioCancelCustomId(interaction.data.custom_id);
  const discordId = interaction.member?.user?.id ?? interaction.user?.id;

  if (!discordId) {
    return ephemeralResponse('I could not identify this studio reservation.');
  }

  if (interaction.data.custom_id === STUDIO_CANCEL_NEXT_CUSTOM_ID) {
    return openStudioCancelModal(discordId, env);
  }

  const path = requestId
    ? `/studio/requests/${encodeURIComponent(requestId)}/cancel-by-discord`
    : null;

  if (!path) {
    return ephemeralResponse('I could not identify this studio reservation.');
  }

  const result = await requestWebsiteApi(env, path, {
    body: { discordId },
    method: 'POST',
  });
  const response = readWebsiteStudioActionResponse(result);

  return ephemeralResponse(
    response.message ??
      (response.ok
        ? 'Studio reservation cancelled.'
        : 'I could not cancel that studio reservation.'),
  );
}

export function handleStudioReviewButton(
  interaction: ComponentInteraction,
): DiscordInteractionResponse {
  const review = parseStudioReviewCustomId(interaction.data.custom_id);
  if (!review) {
    return ephemeralResponse('I could not identify that studio request.');
  }

  if (!hasStudioReviewRole(interaction)) {
    return ephemeralResponse(
      'Only the Executive role can approve or deny studio requests.',
    );
  }

  return {
    data: createStudioReviewModalPayload(review.action, review.requestId),
    type: InteractionResponseType.MODAL,
  };
}

export async function handleStudioModalSubmit(
  interaction: ModalSubmitInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  if (interaction.data.custom_id === STUDIO_BOOKING_MODAL_CUSTOM_ID) {
    return submitStudioBookingModal(interaction, env);
  }

  if (interaction.data.custom_id === STUDIO_CANCEL_MODAL_CUSTOM_ID) {
    return submitStudioCancelModal(interaction, env);
  }

  const review = parseStudioReviewModalCustomId(interaction.data.custom_id);
  if (review) {
    return submitStudioReviewModal(interaction, env, review);
  }

  return ephemeralResponse(
    `That modal is not handled yet: ${interaction.data.custom_id}`,
  );
}

export async function postStudioPendingReviewMessage(
  env: Env,
  event: StudioPendingReviewInternalEvent,
) {
  const channelId = event.channelId ?? STUDIO_PENDING_REVIEW_CHANNEL_ID;
  if (channelId !== STUDIO_PENDING_REVIEW_CHANNEL_ID) {
    throw new BadRequestError('Studio review channel is not allowed.');
  }
  const payload = createStudioPendingReviewPayload(event);
  const { result, replacedStaleMessage } = await editOrSendStoredMessage(env, {
    channelId,
    messageId: event.messageId,
    nonce: buildStudioReviewMessageNonce(event),
    ...payload,
  });

  if (event.status === 'rejected') {
    await notifyRequesterOfStudioManagerUpdate(env, {
      adminNote: event.adminNote,
      endsAt: event.endsAt,
      requestId: event.requestId,
      requesterDiscordId: event.requester.discordId,
      startsAt: event.startsAt,
      status: event.status,
    });
  }

  return {
    channelId,
    messageId:
      readMessageId(result) ??
      (replacedStaleMessage ? null : (event.messageId ?? null)),
  };
}

export async function postStudioScheduleMessage(
  env: Env,
  event: StudioScheduleMessageInternalEvent,
) {
  const channelId = event.channelId ?? STUDIO_SCHEDULE_CHANNEL_ID;
  if (channelId !== STUDIO_SCHEDULE_CHANNEL_ID) {
    throw new BadRequestError(
      'Studio schedule message channel is not allowed.',
    );
  }
  const payload = createStudioScheduleMessagePayload(env);
  const { result, replacedStaleMessage } = await editOrSendStoredMessage(env, {
    channelId,
    messageId: event.messageId,
    nonce: 'st-schedule',
    ...payload,
  });

  return {
    channelId,
    messageId:
      readMessageId(result) ??
      (replacedStaleMessage ? null : (event.messageId ?? null)),
  };
}

async function editOrSendStoredMessage(
  env: Env,
  input: {
    channelId: string;
    components?: unknown[];
    content?: string;
    embeds?: DiscordEmbed[];
    messageId?: string | null | undefined;
    nonce: string;
  },
) {
  if (!input.messageId) {
    return {
      replacedStaleMessage: false,
      result: await sendDiscordMessage(env, {
        channelId: input.channelId,
        components: input.components,
        content: input.content,
        embeds: input.embeds,
        nonce: input.nonce,
      }),
    };
  }

  try {
    return {
      replacedStaleMessage: false,
      result: await editDiscordMessage(env, {
        channelId: input.channelId,
        components: input.components,
        content: input.content,
        embeds: input.embeds,
        messageId: input.messageId,
      }),
    };
  } catch (error) {
    if (isDiscordNotFoundError(error)) {
      logger.warn(
        'Stored studio Discord message was missing; posting a replacement.',
        {
          channelId: input.channelId,
          messageId: input.messageId,
        },
      );

      return {
        replacedStaleMessage: true,
        result: await sendDiscordMessage(env, {
          channelId: input.channelId,
          components: input.components,
          content: input.content,
          embeds: input.embeds,
          nonce: input.nonce,
        }),
      };
    }

    throw error;
  }
}

async function submitStudioBookingModal(
  interaction: ModalSubmitInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const discordId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!discordId) {
    return ephemeralResponse('I could not identify your Discord account.');
  }

  const values = readModalValues(interaction);
  const needsStudioManager = readStudioManagerHelpValue(
    values.get(STUDIO_REQUEST_MANAGER_HELP_CUSTOM_ID),
  );

  let result: unknown;
  try {
    result = await requestWebsiteApi(env, '/studio/requests/by-discord', {
      body: {
        date: readModalString(values.get(STUDIO_REQUEST_DATE_CUSTOM_ID)),
        discordId,
        endsAtLocal: readModalString(
          values.get(STUDIO_REQUEST_END_TIME_CUSTOM_ID),
        ),
        memberNote: readModalString(values.get(STUDIO_REQUEST_NOTE_CUSTOM_ID)),
        needsStudioManager,
        startsAtLocal: readModalString(
          values.get(STUDIO_REQUEST_START_TIME_CUSTOM_ID),
        ),
      },
      method: 'POST',
    });
  } catch (error) {
    logger.warn('Studio booking modal API request failed.', { error });
    return ephemeralResponse(
      'I could not submit that studio request. Try again from the website schedule.',
    );
  }

  const response = readWebsiteStudioActionResponse(result);

  return ephemeralResponse(
    response.message ??
      (response.ok
        ? 'Studio request submitted for studio manager approval.'
        : 'I could not submit that studio request.'),
  );
}

async function openStudioCancelModal(
  discordId: string,
  env: Env,
): Promise<DiscordInteractionResponse> {
  let result: unknown;
  try {
    result = await requestWebsiteApi(
      env,
      '/studio/requests/cancellable-by-discord',
      {
        body: { discordId },
        method: 'POST',
      },
    );
  } catch (error) {
    logger.warn('Studio cancellation list API request failed.', { error });
    return ephemeralResponse(
      'I could not load your studio reservations. Try again from the website schedule.',
    );
  }

  const response = readWebsiteStudioCancellableResponse(result);
  if (response.requests.length === 0) {
    return ephemeralResponse(
      response.message ??
        'You do not have any upcoming studio reservations to cancel.',
    );
  }

  return {
    data: createStudioCancelModalPayload(response.requests),
    type: InteractionResponseType.MODAL,
  };
}

async function submitStudioCancelModal(
  interaction: ModalSubmitInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const discordId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!discordId) {
    return ephemeralResponse('I could not identify your Discord account.');
  }

  const values = readModalValues(interaction);
  const requestId = readFirstModalSelection(
    values.get(STUDIO_CANCEL_REQUEST_CUSTOM_ID),
  );
  if (!requestId) {
    return ephemeralResponse('Choose a studio reservation to cancel.');
  }

  let result: unknown;
  try {
    result = await requestWebsiteApi(
      env,
      `/studio/requests/${encodeURIComponent(requestId)}/cancel-by-discord`,
      {
        body: { discordId },
        method: 'POST',
      },
    );
  } catch (error) {
    logger.warn('Studio cancellation modal API request failed.', { error });
    return ephemeralResponse(
      'I could not cancel that studio reservation. Try again from the website schedule.',
    );
  }

  const response = readWebsiteStudioActionResponse(result);

  return ephemeralResponse(
    response.message ??
      (response.ok
        ? 'Studio reservation cancelled.'
        : 'I could not cancel that studio reservation.'),
  );
}

async function submitStudioReviewModal(
  interaction: ModalSubmitInteraction,
  env: Env,
  review: { action: 'approve' | 'reject'; requestId: string },
): Promise<DiscordInteractionResponse> {
  const discordId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!discordId) {
    return ephemeralResponse('I could not identify your Discord account.');
  }

  if (!hasStudioReviewRole(interaction)) {
    return ephemeralResponse(
      'Only the Executive role can approve or deny studio requests.',
    );
  }

  const values = readModalValues(interaction);
  let result: unknown;
  try {
    result = await requestWebsiteApi(
      env,
      `/admin/studio/${encodeURIComponent(review.requestId)}/review-by-discord`,
      {
        body: {
          action: review.action,
          adminNote: readModalString(values.get(STUDIO_REVIEW_NOTE_CUSTOM_ID)),
          discordId,
        },
        method: 'POST',
      },
    );
  } catch (error) {
    logger.warn('Studio review modal API request failed.', { error });
    return ephemeralResponse(
      'I could not update that studio request. Try again from the admin dashboard.',
    );
  }

  const response = readWebsiteStudioActionResponse(result);

  return ephemeralResponse(
    response.message ??
      (response.ok
        ? review.action === 'approve'
          ? 'Studio request approved.'
          : 'Studio request denied.'
        : 'I could not update that studio request.'),
  );
}

export async function syncStudioScheduleChannel(
  env: Env,
  event: StudioScheduleSyncInternalEvent,
) {
  let syncEvent = event;
  let legacyChannelId: string | null = null;
  let thread: DiscordManagedChannel | null = null;

  await assertStudioScheduleSyncEventCurrent(env, event, {
    allowArchived: event.deleteChannel === true,
  });

  if (event.channelId) {
    const room = await resolveStudioScheduleRoom(env, event.channelId, event);
    if (!room) {
      syncEvent = { ...event, channelId: null, messageId: null };
    } else if (room.kind === 'thread') {
      thread = room.channel;
    } else {
      legacyChannelId = room.channel.id;
      syncEvent = { ...event, channelId: null, messageId: null };
    }
  }

  if (!thread && !syncEvent.channelId) {
    thread = await findManagedPrivateThread(
      env,
      getStudioThreadSpec(syncEvent),
    );
  }

  if (!thread && !legacyChannelId && !syncEvent.channelId) {
    const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
    const existingChannel = await findExistingStudioChannel(
      env,
      guildId,
      syncEvent,
    );
    if (existingChannel) {
      await assertLegacyStudioScheduleChannelOwnership(
        env,
        existingChannel,
        syncEvent,
      );
      legacyChannelId = existingChannel.id;
    }
  }

  if (syncEvent.deleteChannel === true) {
    await notifyRequesterOfStudioManagerUpdate(env, {
      adminNote: syncEvent.adminNote,
      endsAt: syncEvent.endsAt,
      requestId: syncEvent.requestId,
      requesterDiscordId: syncEvent.requester.discordId,
      startsAt: syncEvent.startsAt,
      status: syncEvent.status,
    });
    const channelId = thread?.id ?? legacyChannelId;
    if (channelId) {
      await deleteDiscordManagedChannel(env, channelId);
    }
    return {
      channelId: null,
      messageId: null,
    };
  }

  if (!isActiveStudioChannel(syncEvent)) {
    return {
      channelId: null,
      messageId: null,
    };
  }

  const threadSpec = getStudioThreadSpec(syncEvent);
  let didCreateThread = false;
  if (!thread) {
    thread = await createManagedPrivateThread(
      env,
      buildStudioChannelName(syncEvent),
      threadSpec,
    );
    didCreateThread = true;
  } else {
    thread = await prepareManagedPrivateThread(
      env,
      thread,
      buildStudioChannelName(syncEvent),
      threadSpec,
    );
  }

  try {
    if (didCreateThread) {
      await assertStudioScheduleSyncEventCurrent(env, syncEvent);
    }
    await addManagedPrivateThreadMember(
      env,
      thread.id,
      syncEvent.requester.discordId,
    );
    const messageResult = syncEvent.messageId
      ? await editOrSendStudioMessage(
          env,
          thread.id,
          syncEvent.messageId,
          syncEvent,
        )
      : await sendStudioMessage(env, thread.id, syncEvent);

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
        logger.warn('Failed to roll back a partial studio private thread.', {
          error: rollbackError,
          requestId: syncEvent.requestId,
          threadId: thread.id,
        });
      }
    }
    throw error;
  }
}

async function assertStudioScheduleSyncEventCurrent(
  env: Env,
  event: StudioScheduleSyncInternalEvent,
  options: { allowArchived?: boolean } = {},
) {
  const state = await requestWebsiteApi(
    env,
    `/studio/requests/${encodeURIComponent(event.requestId)}/discord-sync-state`,
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
    throw new BadRequestError('Studio Discord sync event is stale.');
  }
}

async function findExistingStudioChannel(
  env: Env,
  guildId: string,
  event: StudioScheduleSyncInternalEvent,
) {
  const channels = await discordApiRequest<DiscordChannel[]>(
    env,
    `/guilds/${guildId}/channels`,
  );
  const markerPrefix = `${buildStudioTopicOwnershipMarker(event)};REV=`;
  return (
    channels.find(
      (channel) =>
        (channel.type === 0 || channel.type === undefined) &&
        channel.topic?.split(' | ').at(-1)?.startsWith(markerPrefix) === true &&
        (channel.parent_id === STUDIO_SCHEDULE_CATEGORY_ID ||
          channel.parent_id === STUDIO_RESOLVED_CATEGORY_ID),
    ) ?? null
  );
}

async function resolveStudioScheduleRoom(
  env: Env,
  channelId: string,
  event: StudioScheduleSyncInternalEvent,
) {
  const channel = await getDiscordManagedChannel(env, channelId);
  if (!channel) {
    return null;
  }
  if (isDiscordPrivateThread(channel)) {
    assertManagedPrivateThread(env, channel, getStudioThreadSpec(event));
    return { channel, kind: 'thread' as const };
  }

  await assertLegacyStudioScheduleChannelOwnership(env, channel, event);
  return { channel, kind: 'legacy' as const };
}

async function assertLegacyStudioScheduleChannelOwnership(
  env: Env,
  channel: DiscordChannel,
  event: StudioScheduleSyncInternalEvent,
) {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const isAllowedCategory =
    channel.parent_id === STUDIO_SCHEDULE_CATEGORY_ID ||
    channel.parent_id === STUDIO_RESOLVED_CATEGORY_ID;
  const markerPrefix = `${buildStudioTopicOwnershipMarker(event)};REV=`;
  if (
    channel.guild_id !== guildId ||
    (channel.type !== 0 && channel.type !== undefined) ||
    !isAllowedCategory ||
    !channel.topic
  ) {
    throw new BadRequestError('Studio schedule channel ownership mismatch.');
  }

  const terminalMarker = channel.topic.split(' | ').at(-1);
  if (terminalMarker?.startsWith(markerPrefix)) {
    const storedRevision = Number(terminalMarker.slice(markerPrefix.length));
    if (
      !Number.isInteger(storedRevision) ||
      storedRevision > event.syncRevision
    ) {
      throw new BadRequestError('Studio schedule event is stale.');
    }
    return true;
  }

  const legacyPrefix = `Studio reservation: ${formatPlainDateTime(event.startsAt)} - ${formatPlainDateTime(event.endsAt)} | Member ${event.requester.name} | `;
  if (!channel.topic.startsWith(legacyPrefix)) {
    throw new BadRequestError('Studio schedule channel marker mismatch.');
  }

  await discordApiRequest(env, `/channels/${channel.id}`, {
    body: JSON.stringify({ topic: buildStudioTopic(event) }),
    method: 'PATCH',
  });
}

async function sendStudioMessage(
  env: Env,
  channelId: string,
  event: StudioScheduleSyncInternalEvent,
) {
  return sendDiscordMessage(env, {
    channelId,
    components: buildStudioSessionComponents(env, event),
    content: buildStudioSessionContent(event),
    embeds: [buildStudioSessionEmbed(event)],
    nonce: buildStudioScheduleMessageNonce(event),
  });
}

function buildStudioScheduleMessageNonce(
  event: StudioScheduleSyncInternalEvent,
) {
  return `st-slot-${event.requestId.slice(-16)}`;
}

function buildStudioReviewMessageNonce(
  event: StudioPendingReviewInternalEvent,
) {
  return `st-review-${event.requestId.slice(-15)}`;
}

async function editStudioMessage(
  env: Env,
  channelId: string,
  messageId: string,
  event: StudioScheduleSyncInternalEvent,
) {
  return editDiscordMessage(env, {
    channelId,
    components: buildStudioSessionComponents(env, event),
    content: buildStudioSessionContent(event),
    embeds: [buildStudioSessionEmbed(event)],
    messageId,
  });
}

async function editOrSendStudioMessage(
  env: Env,
  channelId: string,
  messageId: string,
  event: StudioScheduleSyncInternalEvent,
) {
  try {
    return await editStudioMessage(env, channelId, messageId, event);
  } catch (error) {
    if (isDiscordNotFoundError(error)) {
      return sendStudioMessage(env, channelId, event);
    }

    throw error;
  }
}

function createStudioScheduleMessagePayload(env: Env) {
  const websiteUrl =
    getOptionalEnv(env, 'WEBSITE_URL') ?? 'https://purduephotoclub.org';
  const scheduleUrl = `${websiteUrl.replace(/\/+$/, '')}/dashboard/studio`;

  return {
    components: [
      {
        components: [
          {
            custom_id: STUDIO_SCHEDULE_BOOK_CUSTOM_ID,
            label: 'Book studio time',
            style: PRIMARY_BUTTON,
            type: BUTTON,
          },
          {
            custom_id: STUDIO_CANCEL_NEXT_CUSTOM_ID,
            label: 'Cancel my reservation',
            style: DANGER_BUTTON,
            type: BUTTON,
          },
          {
            label: 'Open studio schedule',
            style: LINK_BUTTON,
            type: BUTTON,
            url: scheduleUrl,
          },
        ],
        type: ACTION_ROW,
      },
    ],
    embeds: [
      {
        color: 0x8b5cf6,
        description: [
          'Facilities members can request studio reservations between 6:00 AM and 12:00 AM.',
          'Submit your time, then wait for studio manager approval before the reservation is confirmed.',
        ].join('\n'),
        fields: [
          {
            inline: false,
            name: 'How it works',
            value:
              'Open the schedule, choose your date and start/end time, submit the request, then watch for studio manager approval.',
          },
        ],
        footer: {
          text: 'Purdue Photography Club studio schedule',
        },
        title: 'Schedule Studio Time',
      },
    ],
  };
}

function createStudioBookingModalPayload() {
  return {
    components: [
      createTextInputLabel({
        customId: STUDIO_REQUEST_DATE_CUSTOM_ID,
        label: 'Date',
        placeholder: 'YYYY-MM-DD',
        required: true,
        style: SHORT_TEXT,
      }),
      createTextInputLabel({
        customId: STUDIO_REQUEST_START_TIME_CUSTOM_ID,
        label: 'Start time',
        placeholder: '6:00 PM',
        required: true,
        style: SHORT_TEXT,
      }),
      createTextInputLabel({
        customId: STUDIO_REQUEST_END_TIME_CUSTOM_ID,
        label: 'End time',
        placeholder: '8:30 PM',
        required: true,
        style: SHORT_TEXT,
      }),
      {
        component: {
          custom_id: STUDIO_REQUEST_MANAGER_HELP_CUSTOM_ID,
          default: false,
          type: CHECKBOX,
        },
        description: 'Check this for access, setup, or handoff help.',
        label: 'Studio manager help',
        type: LABEL,
      },
      createTextInputLabel({
        customId: STUDIO_REQUEST_NOTE_CUSTOM_ID,
        label: 'Project note',
        placeholder: 'Backdrop, lighting, or project details',
        required: false,
        style: PARAGRAPH_TEXT,
      }),
    ],
    custom_id: STUDIO_BOOKING_MODAL_CUSTOM_ID,
    title: 'Request studio time',
  };
}

function createStudioCancelModalPayload(
  requests: WebsiteStudioCancellableRequest[],
) {
  return {
    components: [
      {
        component: {
          custom_id: STUDIO_CANCEL_REQUEST_CUSTOM_ID,
          options: requests.slice(0, 25).map(createStudioCancelOption),
          placeholder: 'Choose a studio reservation',
          type: STRING_SELECT,
        },
        description: 'Pick the studio reservation you want to cancel.',
        label: 'Reservation to cancel',
        type: LABEL,
      },
    ],
    custom_id: STUDIO_CANCEL_MODAL_CUSTOM_ID,
    title: 'Cancel studio time',
  };
}

function createStudioReviewModalPayload(
  action: 'approve' | 'reject',
  requestId: string,
) {
  return {
    components: [
      createTextInputLabel({
        customId: STUDIO_REVIEW_NOTE_CUSTOM_ID,
        label: action === 'approve' ? 'Approval note' : 'Denial note',
        placeholder:
          action === 'approve'
            ? 'Optional setup, cleanup, or access note'
            : 'Tell the member what needs to change',
        required: false,
        style: PARAGRAPH_TEXT,
      }),
    ],
    custom_id: `${STUDIO_REVIEW_MODAL_CUSTOM_ID_PREFIX}${action}:${requestId}`,
    title:
      action === 'approve' ? 'Approve studio request' : 'Deny studio request',
  };
}

function createStudioPendingReviewPayload(
  event: StudioPendingReviewInternalEvent,
) {
  return {
    components:
      event.status === 'pending'
        ? [
            {
              components: [
                {
                  custom_id: `${STUDIO_REVIEW_CUSTOM_ID_PREFIX}approve:${event.requestId}`,
                  label: 'Approve with note',
                  style: SUCCESS_BUTTON,
                  type: BUTTON,
                },
                {
                  custom_id: `${STUDIO_REVIEW_CUSTOM_ID_PREFIX}reject:${event.requestId}`,
                  label: 'Deny with note',
                  style: DANGER_BUTTON,
                  type: BUTTON,
                },
              ],
              type: ACTION_ROW,
            },
          ]
        : [],
    embeds: [
      {
        color: getStudioPendingReviewColor(event.status),
        description: event.memberNote || 'No member note provided.',
        fields: [
          {
            inline: true,
            name: 'Starts',
            value: formatDiscordTimestamp(new Date(event.startsAt)),
          },
          {
            inline: true,
            name: 'Ends',
            value: formatDiscordTimestamp(new Date(event.endsAt)),
          },
          {
            inline: false,
            name: 'Member',
            value: formatRequester(event.requester),
          },
          {
            inline: false,
            name: 'Studio manager help',
            value: event.needsStudioManager
              ? '[x] Studio manager help requested'
              : '[ ] No manager help requested',
          },
          ...(event.adminNote
            ? [
                {
                  inline: false,
                  name: 'Admin note',
                  value: event.adminNote,
                },
              ]
            : []),
        ],
        footer: {
          text: `Studio request ${event.requestId}`,
        },
        timestamp: new Date().toISOString(),
        title: `${capitalize(event.status)} Studio Request`,
      },
    ],
  };
}

function createTextInputLabel(options: {
  customId: string;
  label: string;
  placeholder: string;
  required: boolean;
  style: number;
}) {
  return {
    component: {
      custom_id: options.customId,
      max_length: options.style === PARAGRAPH_TEXT ? 500 : 80,
      placeholder: options.placeholder,
      required: options.required,
      style: options.style,
      type: INPUT_TEXT,
    },
    label: options.label,
    type: LABEL,
  };
}

function createStudioCancelOption(request: WebsiteStudioCancellableRequest) {
  return {
    description: truncate(`${capitalize(request.status)} studio request`, 100),
    label: truncate(
      `${formatPlainDateTime(request.startsAt)} - ${formatPlainTime(request.endsAt)}`,
      100,
    ),
    value: truncate(request.id, 100),
  };
}

function buildStudioSessionComponents(
  env: Env,
  event: StudioScheduleSyncInternalEvent,
) {
  const websiteUrl =
    getOptionalEnv(env, 'WEBSITE_URL') ?? 'https://purduephotoclub.org';
  const components = [
    ...(isActiveStudioChannel(event)
      ? [
          {
            custom_id: `${STUDIO_CANCEL_CUSTOM_ID_PREFIX}${event.requestId}`,
            label: 'Cancel reservation',
            style: DANGER_BUTTON,
            type: BUTTON,
          },
        ]
      : []),
    {
      label: 'Open studio schedule',
      style: LINK_BUTTON,
      type: BUTTON,
      url: `${websiteUrl.replace(/\/+$/, '')}/dashboard/studio`,
    },
  ];

  return [
    {
      components,
      type: ACTION_ROW,
    },
  ];
}

function buildStudioSessionContent(event: StudioScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 'This studio reservation has been cancelled. The website dashboard is the source of truth.';
  }

  if (isPastStudioReservation(event)) {
    return 'This studio reservation has ended.';
  }

  return 'Studio reservation coordination thread. Use this space for access, setup, cleanup, and handoff details.';
}

function buildStudioSessionEmbed(event: StudioScheduleSyncInternalEvent) {
  return {
    color: getStudioEmbedColor(event),
    fields: [
      {
        inline: true,
        name: 'Starts',
        value: formatDiscordTimestamp(new Date(event.startsAt)),
      },
      {
        inline: true,
        name: 'Ends',
        value: formatDiscordTimestamp(new Date(event.endsAt)),
      },
      {
        inline: false,
        name: 'Member',
        value: event.requester.name,
      },
    ],
    footer: {
      text: `Studio request ${event.requestId}`,
    },
    timestamp: new Date().toISOString(),
    title: `${getStudioTitlePrefix(event)}Studio Reservation`,
  };
}

async function notifyRequesterOfStudioManagerUpdate(
  env: Env,
  input: {
    adminNote: string | null | undefined;
    endsAt: string;
    requesterDiscordId: string | null | undefined;
    requestId: string;
    startsAt: string;
    status:
      | StudioPendingReviewInternalEvent['status']
      | StudioScheduleSyncInternalEvent['status'];
  },
) {
  const adminNote = input.adminNote?.trim();
  const requesterDiscordId = input.requesterDiscordId?.trim();
  if (
    !adminNote ||
    !requesterDiscordId ||
    (input.status !== 'cancelled' && input.status !== 'rejected')
  ) {
    return;
  }

  try {
    await sendDiscordDirectMessage(env, {
      content: buildStudioManagerUpdateDmContent({
        adminNote,
        endsAt: input.endsAt,
        startsAt: input.startsAt,
        status: input.status,
      }),
      nonce: `std-${input.status[0]}-${input.requestId.slice(-12)}`,
      recipientId: requesterDiscordId,
    });
  } catch (error) {
    logger.warn('Failed to send studio manager update DM.', {
      error,
      requestId: input.requestId,
      requesterDiscordId,
      status: input.status,
    });
  }
}

function buildStudioManagerUpdateDmContent(input: {
  adminNote: string;
  endsAt: string;
  startsAt: string;
  status: 'cancelled' | 'rejected';
}) {
  const action = input.status === 'rejected' ? 'denied' : 'cancelled';

  return [
    `Your studio request for ${formatPlainDateTime(input.startsAt)} - ${formatPlainTime(input.endsAt)} was ${action}.`,
    '',
    `Manager note: ${truncate(input.adminNote, 1_500)}`,
    '',
    'Open the studio schedule if you need to request another time.',
  ].join('\n');
}

function buildStudioChannelName(event: StudioScheduleSyncInternalEvent) {
  const startsAt = new Date(event.startsAt);
  const weekday = startsAt
    .toLocaleString('en-US', {
      timeZone: 'America/Indiana/Indianapolis',
      weekday: 'short',
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
  const prefix = event.status === 'cancelled' ? 'cancelled-studio' : 'studio';

  return sanitizeChannelName(
    `${prefix}-${weekday}-${month}-${day}-${hour}-${event.requester.name}`,
  );
}

function getStudioThreadSpec(
  event: StudioScheduleSyncInternalEvent,
): ManagedPrivateThreadSpec {
  return {
    marker: `--pcc-studio-${event.requestId}`,
    parentChannelId: STUDIO_SCHEDULE_CHANNEL_ID,
    syncRevision: event.syncRevision,
  };
}

function buildStudioTopic(event: StudioScheduleSyncInternalEvent) {
  const marker = buildStudioTopicMarker(event);
  const details = [
    `Studio reservation: ${formatPlainDateTime(event.startsAt)} - ${formatPlainDateTime(event.endsAt)}`,
    `Member ${event.requester.name}`,
    event.status === 'cancelled' ? 'Cancelled' : 'Approved',
  ].join(' | ');
  return `${truncate(details, 1_024 - marker.length - 3)} | ${marker}`;
}

function buildStudioTopicMarker(event: StudioScheduleSyncInternalEvent) {
  return `${buildStudioTopicOwnershipMarker(event)};REV=${event.syncRevision}`;
}

function buildStudioTopicOwnershipMarker(
  event: StudioScheduleSyncInternalEvent,
) {
  return `PCC_STUDIO_REQUEST=${event.requestId}`;
}

function isActiveStudioChannel(event: StudioScheduleSyncInternalEvent) {
  return event.status === 'approved' && !isPastStudioReservation(event);
}

function isPastStudioReservation(event: StudioScheduleSyncInternalEvent) {
  return Date.parse(event.endsAt) <= Date.now();
}

function getStudioEmbedColor(event: StudioScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 0xf85149;
  }

  if (isPastStudioReservation(event)) {
    return 0x6b7280;
  }

  return 0x8b5cf6;
}

function getStudioPendingReviewColor(
  status: StudioPendingReviewInternalEvent['status'],
) {
  switch (status) {
    case 'approved':
      return 0x22c55e;
    case 'cancelled':
      return 0x6b7280;
    case 'rejected':
      return 0xf85149;
    default:
      return 0xf59e0b;
  }
}

function getStudioTitlePrefix(event: StudioScheduleSyncInternalEvent) {
  if (event.status === 'cancelled') {
    return 'Cancelled: ';
  }

  return isPastStudioReservation(event) ? 'Ended: ' : '';
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

function formatPlainTime(value: string) {
  return new Date(value).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Indiana/Indianapolis',
  });
}

function formatRequester(
  requester: StudioPendingReviewInternalEvent['requester'],
) {
  return requester.discordId
    ? `${requester.name} (<@${requester.discordId}>)`
    : requester.name;
}

function readModalValues(interaction: ModalSubmitInteraction) {
  const values = new Map<string, ModalValue>();

  for (const row of interaction.data.components ?? []) {
    if (!isRecord(row)) {
      continue;
    }

    if (isRecord(row.component)) {
      addModalComponentValue(values, row.component);
    }

    if (!Array.isArray(row.components)) {
      continue;
    }

    for (const component of row.components) {
      addModalComponentValue(values, component);
    }
  }

  return values;
}

function addModalComponentValue(
  values: Map<string, ModalValue>,
  component: unknown,
) {
  if (!isRecord(component) || typeof component.custom_id !== 'string') {
    return;
  }

  if (typeof component.value === 'boolean') {
    values.set(component.custom_id, component.value);
    return;
  }

  if (typeof component.value === 'string') {
    values.set(component.custom_id, component.value.trim());
    return;
  }

  if (Array.isArray(component.values)) {
    values.set(
      component.custom_id,
      component.values.filter(
        (value): value is string => typeof value === 'string',
      ),
    );
    return;
  }

  values.set(component.custom_id, '');
}

function readModalString(value: ModalValue | undefined) {
  return typeof value === 'string' ? value : '';
}

function readFirstModalSelection(value: ModalValue | undefined) {
  if (!Array.isArray(value)) {
    return null;
  }

  const [firstValue] = value;
  return firstValue?.trim() ? firstValue : null;
}

function readStudioManagerHelpValue(value: ModalValue | undefined) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  const normalized = value?.trim().toLowerCase() ?? '';
  if (['1', 'true', 'y', 'yes'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'n', 'no'].includes(normalized)) {
    return false;
  }

  return false;
}

function parseStudioReviewCustomId(customId: string) {
  if (!customId.startsWith(STUDIO_REVIEW_CUSTOM_ID_PREFIX)) {
    return null;
  }

  return parseStudioReviewParts(
    customId.slice(STUDIO_REVIEW_CUSTOM_ID_PREFIX.length),
  );
}

function parseStudioCancelCustomId(customId: string) {
  if (!customId.startsWith(STUDIO_CANCEL_CUSTOM_ID_PREFIX)) {
    return null;
  }

  const requestId = customId.slice(STUDIO_CANCEL_CUSTOM_ID_PREFIX.length);
  return requestId.trim() ? requestId : null;
}

function parseStudioReviewModalCustomId(customId: string) {
  if (!customId.startsWith(STUDIO_REVIEW_MODAL_CUSTOM_ID_PREFIX)) {
    return null;
  }

  return parseStudioReviewParts(
    customId.slice(STUDIO_REVIEW_MODAL_CUSTOM_ID_PREFIX.length),
  );
}

function isDiscordNotFoundError(error: unknown) {
  return (
    (error instanceof DiscordApiError && error.status === 404) ||
    (typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status?: unknown }).status === 404)
  );
}

function parseStudioReviewParts(value: string) {
  const [action, ...requestParts] = value.split(':');
  const requestId = requestParts.join(':');

  if ((action !== 'approve' && action !== 'reject') || !requestId) {
    return null;
  }

  return {
    action,
    requestId,
  } as const;
}

function hasStudioReviewRole(interaction: { member?: { roles?: string[] } }) {
  return (interaction.member?.roles ?? []).some(
    (roleId) =>
      roleId === DISCORD_ROLE_IDS.executive ||
      roleId === DISCORD_ROLE_IDS.admin,
  );
}

function readWebsiteStudioActionResponse(
  value: unknown,
): WebsiteStudioActionResponse {
  if (!isRecord(value)) {
    return {};
  }

  return {
    ok: value.ok === true,
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  };
}

function readWebsiteStudioCancellableResponse(
  value: unknown,
): WebsiteStudioCancellableResponse {
  if (!isRecord(value)) {
    return { requests: [] };
  }

  return {
    ok: value.ok === true,
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    requests: Array.isArray(value.requests)
      ? value.requests
          .map(readWebsiteStudioCancellableRequest)
          .filter(
            (request): request is WebsiteStudioCancellableRequest => !!request,
          )
      : [],
  };
}

function readWebsiteStudioCancellableRequest(
  value: unknown,
): WebsiteStudioCancellableRequest | null {
  if (!isRecord(value)) {
    return null;
  }

  const { endsAt, id, startsAt, status } = value;
  if (
    typeof endsAt !== 'string' ||
    typeof id !== 'string' ||
    typeof startsAt !== 'string'
  ) {
    return null;
  }

  return {
    endsAt,
    id,
    startsAt,
    status: typeof status === 'string' ? status : 'approved',
  };
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function sanitizeChannelName(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'studio-reservation'
  );
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
