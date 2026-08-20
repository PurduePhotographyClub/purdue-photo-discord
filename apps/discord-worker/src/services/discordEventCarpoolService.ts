import { discordApiRequest } from '../discord/api';
import { ephemeralResponse } from '../discord/responses';
import type {
  ApplicationCommandInteraction,
  ComponentInteraction,
  DiscordInteractionResponse,
  DiscordMessagePayload,
  Env,
  ModalSubmitInteraction,
} from '../discord/types';
import type { EventCarpoolExpiryInternalEvent } from '../internal-events/types';
import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import { AppError, DiscordApiError, getErrorMessage } from '../utils/errors';
import { getRequiredEnv } from '../utils/env';
import { requestWebsiteApi } from './websiteApiService';
import { InteractionResponseType } from 'discord-interactions';
import {
  createEventCarpoolMessagePayload,
  EVENT_CARPOOL_CUSTOM_ID_PREFIX,
  EVENT_CARPOOL_DISCLAIMER,
  EVENT_CARPOOL_FORUM_NAME,
  EVENT_CARPOOL_TAG_NAMES,
  findStatusTag,
  statusTagName,
  type DiscordForumChannel,
  type EventCarpoolProjection,
} from './discordEventCarpoolPresentation';

export { createEventCarpoolMessagePayload } from './discordEventCarpoolPresentation';
export type { EventCarpoolProjection } from './discordEventCarpoolPresentation';

const EVENT_CARPOOL_CREATE_CUSTOM_ID = `${EVENT_CARPOOL_CUSTOM_ID_PREFIX}create`;
const EVENT_CARPOOL_DRIVER_MODAL_PREFIX = `${EVENT_CARPOOL_CUSTOM_ID_PREFIX}driver_modal:`;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const ACTION_ROW = 1;
const BUTTON = 2;
const TEXT_INPUT = 4;
const LABEL = 18;
const SHORT_TEXT = 1;
const PARAGRAPH_TEXT = 2;
const PRIMARY_BUTTON = 1;
const FORUM_CHANNEL = 15;

export const EVENT_CARPOOL_CREATE_MODAL_CUSTOM_ID = `${EVENT_CARPOOL_CUSTOM_ID_PREFIX}create_modal`;

const EVENT_CARPOOL_TITLE_INPUT = 'event_carpool_title';
const EVENT_CARPOOL_DESTINATION_INPUT = 'event_carpool_destination';
const EVENT_CARPOOL_MEETING_POINT_INPUT = 'event_carpool_meeting_point';
const EVENT_CARPOOL_DEPARTS_AT_INPUT = 'event_carpool_departs_at';
const EVENT_CARPOOL_RETURNS_AT_INPUT = 'event_carpool_returns_at';
const EVENT_CARPOOL_SEATS_INPUT = 'event_carpool_seats';
const EVENT_CARPOOL_NOTE_INPUT = 'event_carpool_note';

interface DiscordForumThreadResult {
  id?: string;
  message?: { id?: string };
}

export function handleEventCarpoolsCommand(): DiscordInteractionResponse {
  return {
    data: createEventCarpoolModal(),
    type: InteractionResponseType.MODAL,
  };
}

export async function handleEventCarpoolsSetupCommand(
  interaction: ApplicationCommandInteraction,
  env: Env,
) {
  if (!isEventCarpoolStaff(interaction)) {
    return ephemeralResponse(
      'Only the Executive or Discord Admin role can set up event carpools.',
    );
  }
  const guildId =
    interaction.guild_id ?? getRequiredEnv(env, 'DISCORD_GUILD_ID');
  try {
    const forum = await ensureEventCarpoolForum(env, guildId);
    await ensureEventCarpoolStartPost(env, guildId, forum);
    return ephemeralResponse(`Event carpools are ready in <#${forum.id}>.`);
  } catch (error) {
    return ephemeralResponse(
      `Could not set up event carpools: ${readEventCarpoolError(error)}`,
    );
  }
}

export function isEventCarpoolButtonCustomId(customId: string) {
  return (
    customId.startsWith(EVENT_CARPOOL_CUSTOM_ID_PREFIX) &&
    !customId.startsWith(EVENT_CARPOOL_DRIVER_MODAL_PREFIX) &&
    customId !== EVENT_CARPOOL_CREATE_MODAL_CUSTOM_ID
  );
}

export function shouldDeferEventCarpoolButton(customId: string) {
  const parsed = parseEventCarpoolButton(customId);
  return (
    parsed !== null && parsed.action !== 'create' && parsed.action !== 'drive'
  );
}

export function isEventCarpoolModalCustomId(customId: string) {
  return (
    customId === EVENT_CARPOOL_CREATE_MODAL_CUSTOM_ID ||
    parseEventCarpoolDriverModalId(customId) !== null
  );
}

export async function handleEventCarpoolButton(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const parsed = parseEventCarpoolButton(interaction.data.custom_id);
  if (!parsed)
    return ephemeralResponse('I could not identify that event carpool.');
  if (parsed.action === 'create') return handleEventCarpoolsCommand();
  if (parsed.action === 'drive') {
    return {
      data: createDriverModal(parsed.eventId),
      type: InteractionResponseType.MODAL,
    };
  }

  const actorDiscordId = readActorDiscordId(interaction);
  if (!actorDiscordId)
    return ephemeralResponse('I could not identify your Discord account.');
  try {
    const isStaff = isEventCarpoolStaff(interaction);
    const path = `/event-carpools/${encodeURIComponent(parsed.eventId)}`;
    const result =
      parsed.action === 'ride'
        ? await requestEventCarpool(env, `${path}/participants/by-discord`, {
            actorDiscordId,
            role: 'rider',
          })
        : parsed.action === 'withdraw'
          ? await requestEventCarpool(env, `${path}/withdraw-by-discord`, {
              actorDiscordId,
            })
          : await requestEventCarpoolControl(
              env,
              path,
              parsed.action,
              actorDiscordId,
              isStaff,
            );
    await syncEventCarpoolProjectionAndPersist(env, result);
    const actionMessage = {
      assign: 'Riders assigned.',
      cancel: 'Event carpool cancelled.',
      reopen: 'Event carpool reopened for signups.',
      ride: 'You are signed up as a rider.',
      withdraw: 'You have withdrawn from this event carpool.',
    }[parsed.action];
    return ephemeralResponse(actionMessage);
  } catch (error) {
    return ephemeralResponse(readEventCarpoolError(error));
  }
}

export async function handleEventCarpoolModalSubmit(
  interaction: ModalSubmitInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const actorDiscordId = readActorDiscordId(interaction);
  if (!actorDiscordId)
    return ephemeralResponse('I could not identify your Discord account.');
  try {
    if (interaction.data.custom_id === EVENT_CARPOOL_CREATE_MODAL_CUSTOM_ID) {
      return await submitEventCarpoolCreateModal(
        interaction,
        env,
        actorDiscordId,
      );
    }
    const eventId = parseEventCarpoolDriverModalId(interaction.data.custom_id);
    if (!eventId)
      return ephemeralResponse('I could not identify that event carpool.');
    const values = readModalValues(interaction);
    const offeredSeats = Number(values.get(EVENT_CARPOOL_SEATS_INPUT));
    const note = values.get(EVENT_CARPOOL_NOTE_INPUT)?.trim() || null;
    if (
      !Number.isInteger(offeredSeats) ||
      offeredSeats < 1 ||
      offeredSeats > 8
    ) {
      return ephemeralResponse(
        'Enter 1–8 passenger seats, excluding the driver.',
      );
    }
    const result = await requestEventCarpool(
      env,
      `/event-carpools/${encodeURIComponent(eventId)}/participants/by-discord`,
      { actorDiscordId, note, offeredSeats, role: 'driver' },
    );
    await syncEventCarpoolProjectionAndPersist(env, result);
    return ephemeralResponse(
      `You are offering ${offeredSeats} passenger seat(s).`,
    );
  } catch (error) {
    return ephemeralResponse(readEventCarpoolError(error));
  }
}

async function submitEventCarpoolCreateModal(
  interaction: ModalSubmitInteraction,
  env: Env,
  actorDiscordId: string,
) {
  const interactionId = interaction.id;
  const guildId =
    interaction.guild_id ?? getRequiredEnv(env, 'DISCORD_GUILD_ID');
  if (!interactionId || !SNOWFLAKE_PATTERN.test(interactionId)) {
    return ephemeralResponse('I could not identify this Discord interaction.');
  }
  const values = readModalValues(interaction);
  const input = {
    actorDiscordId,
    departsAtLocal: values.get(EVENT_CARPOOL_DEPARTS_AT_INPUT) ?? '',
    destination: values.get(EVENT_CARPOOL_DESTINATION_INPUT) ?? '',
    interactionId,
    meetingPoint: values.get(EVENT_CARPOOL_MEETING_POINT_INPUT) ?? '',
    returnsAtLocal: values.get(EVENT_CARPOOL_RETURNS_AT_INPUT) ?? '',
    title: values.get(EVENT_CARPOOL_TITLE_INPUT) ?? '',
  };
  const forum = await findEventCarpoolForum(env, guildId);
  if (!forum) {
    return ephemeralResponse(
      'The event-carpools forum is not set up yet. Ask an Executive member to run `/event-carpools-setup`.',
    );
  }
  const created = await requestEventCarpool(
    env,
    '/event-carpools/by-discord',
    input,
  );
  if (created.status !== 'provisioning' && created.threadId) {
    return ephemeralResponse(
      `Event carpool already exists: <#${created.threadId}>`,
    );
  }
  const thread = await createEventCarpoolForumThread(env, forum, {
    ...created,
    forumChannelId: forum.id,
    status: 'open',
    syncRevision: created.syncRevision + 1,
  });
  const threadId = requireSnowflake(thread.id, 'Discord event carpool thread');
  const rootMessageId = requireSnowflake(
    thread.message?.id ?? thread.id,
    'Discord event carpool starter message',
  );
  await requestEventCarpool(
    env,
    `/event-carpools/${encodeURIComponent(created.id)}/discord-sync-result-by-discord`,
    {
      actorDiscordId,
      expectedRevision: created.syncRevision,
      forumChannelId: forum.id,
      isStaff: isEventCarpoolStaff(interaction),
      rootMessageId,
      threadId,
    },
  );
  return ephemeralResponse(`Event carpool created: <#${threadId}>`);
}

async function syncEventCarpoolProjection(
  env: Env,
  event: EventCarpoolProjection,
) {
  if (!event.threadId || !event.rootMessageId || !event.forumChannelId) return;
  await discordApiRequest(
    env,
    `/channels/${event.threadId}/messages/${event.rootMessageId}`,
    {
      body: JSON.stringify(createEventCarpoolMessagePayload(event)),
      method: 'PATCH',
    },
  );
  const forum = await discordApiRequest<DiscordForumChannel>(
    env,
    `/channels/${event.forumChannelId}`,
  );
  const tagId = findStatusTag(forum, statusTagName(event));
  if (tagId) {
    await discordApiRequest(env, `/channels/${event.threadId}`, {
      body: JSON.stringify({ applied_tags: [tagId] }),
      method: 'PATCH',
    });
  }
}

async function syncEventCarpoolProjectionAndPersist(
  env: Env,
  event: EventCarpoolProjection,
) {
  try {
    await syncEventCarpoolProjection(env, event);
  } catch (error) {
    await persistEventCarpoolProjectionSyncResult(
      env,
      event,
      false,
      getErrorMessage(error).slice(0, 300),
    ).catch(() => undefined);
    throw error;
  }
  await persistEventCarpoolProjectionSyncResult(env, event, true, null);
}

async function persistEventCarpoolProjectionSyncResult(
  env: Env,
  event: EventCarpoolProjection,
  success: boolean,
  error: string | null,
) {
  await requestWebsiteApi(
    env,
    `/event-carpools/${encodeURIComponent(event.id)}/projection-sync-result-by-discord`,
    {
      body: { error, success, syncRevision: event.syncRevision },
      method: 'POST',
    },
  );
}

export async function expireDiscordEventCarpool(
  env: Env,
  event: EventCarpoolExpiryInternalEvent,
) {
  if (!event.threadId || !event.rootMessageId || !event.forumChannelId) {
    return { updated: false };
  }
  try {
    await discordApiRequest(
      env,
      `/channels/${event.threadId}/messages/${event.rootMessageId}`,
      {
        body: JSON.stringify({
          allowed_mentions: { parse: [] },
          components: [],
          content:
            'This event carpool has ended. Its signup data has been deleted, including assignments.',
          embeds: [],
        }),
        method: 'PATCH',
      },
    );
    const forum = await discordApiRequest<DiscordForumChannel>(
      env,
      `/channels/${event.forumChannelId}`,
    );
    const pastTagId = findStatusTag(forum, 'Past');
    if (pastTagId) {
      await discordApiRequest(env, `/channels/${event.threadId}`, {
        body: JSON.stringify({ applied_tags: [pastTagId] }),
        method: 'PATCH',
      });
    }
    return { updated: true };
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      return { updated: false };
    }
    throw error;
  }
}

async function requestEventCarpool(
  env: Env,
  path: string,
  body: Record<string, unknown>,
) {
  return requireEventCarpoolProjection(
    await requestWebsiteApi(env, path, { body, method: 'POST' }),
  );
}

async function requestEventCarpoolControl(
  env: Env,
  eventPath: string,
  action: 'assign' | 'cancel' | 'reopen',
  actorDiscordId: string,
  isStaff: boolean,
) {
  const state = requireEventCarpoolSyncState(
    await requestWebsiteApi(env, `${eventPath}/discord-sync-state`, {
      method: 'GET',
    }),
  );
  return requestEventCarpool(env, `${eventPath}/${action}-by-discord`, {
    actorDiscordId,
    expectedRevision: state.syncRevision,
    isStaff,
  });
}

function requireEventCarpoolSyncState(value: unknown) {
  if (!isRecord(value) || !isRecord(value.eventCarpool)) {
    throw new Error('The API returned an invalid event carpool state.');
  }
  const state = value.eventCarpool;
  if (
    typeof state.id !== 'string' ||
    !UUID_PATTERN.test(state.id) ||
    typeof state.syncRevision !== 'number' ||
    !Number.isInteger(state.syncRevision) ||
    state.syncRevision < 0
  ) {
    throw new Error('The API returned an invalid event carpool state.');
  }
  return { syncRevision: state.syncRevision };
}

function requireEventCarpoolProjection(value: unknown): EventCarpoolProjection {
  if (!isRecord(value) || !isRecord(value.eventCarpool)) {
    throw new Error('The API returned an invalid event carpool.');
  }
  const event = value.eventCarpool;
  const status = event.status;
  if (
    typeof event.id !== 'string' ||
    !UUID_PATTERN.test(event.id) ||
    typeof event.organizerDiscordId !== 'string' ||
    typeof event.title !== 'string' ||
    typeof event.destination !== 'string' ||
    typeof event.meetingPoint !== 'string' ||
    typeof event.departsAt !== 'string' ||
    typeof event.returnsAt !== 'string' ||
    !Array.isArray(event.participants) ||
    !Array.isArray(event.assignments) ||
    typeof event.syncRevision !== 'number' ||
    (status !== 'provisioning' &&
      status !== 'open' &&
      status !== 'assigned' &&
      status !== 'cancelled')
  ) {
    throw new Error('The API returned an invalid event carpool.');
  }
  return event as unknown as EventCarpoolProjection;
}

async function findEventCarpoolForum(env: Env, guildId: string) {
  const channels = await discordApiRequest<DiscordForumChannel[]>(
    env,
    `/guilds/${guildId}/channels`,
  );
  return (
    channels.find(
      (channel) =>
        channel.type === FORUM_CHANNEL &&
        channel.name === EVENT_CARPOOL_FORUM_NAME,
    ) ?? null
  );
}

async function ensureEventCarpoolForum(env: Env, guildId: string) {
  const existing = await findEventCarpoolForum(env, guildId);
  if (existing) return existing;
  return discordApiRequest<DiscordForumChannel>(
    env,
    `/guilds/${guildId}/channels`,
    {
      body: JSON.stringify({
        available_tags: EVENT_CARPOOL_TAG_NAMES.map((name) => ({
          moderated: false,
          name,
        })),
        default_auto_archive_duration: 10_080,
        name: EVENT_CARPOOL_FORUM_NAME,
        topic: `${EVENT_CARPOOL_DISCLAIMER} Do not post phone numbers, home addresses, or vehicle details.`,
        type: FORUM_CHANNEL,
      }),
      method: 'POST',
    },
  );
}

async function ensureEventCarpoolStartPost(
  env: Env,
  guildId: string,
  forum: DiscordForumChannel,
) {
  const active = await discordApiRequest<{
    threads?: Array<{ id?: string; name?: string; parent_id?: string }>;
  }>(env, `/guilds/${guildId}/threads/active`);
  if (
    active.threads?.some(
      (thread) => thread.parent_id === forum.id && thread.name === 'Start here',
    )
  )
    return;
  await discordApiRequest(env, `/channels/${forum.id}/threads`, {
    body: JSON.stringify({
      applied_tags: compact([findStatusTag(forum, 'Open')]),
      auto_archive_duration: 10_080,
      message: {
        allowed_mentions: { parse: [] },
        components: [
          {
            components: [
              {
                custom_id: EVENT_CARPOOL_CREATE_CUSTOM_ID,
                label: 'Create event carpool',
                style: PRIMARY_BUTTON,
                type: BUTTON,
              },
            ],
            type: ACTION_ROW,
          },
        ],
        content: `${EVENT_CARPOOL_DISCLAIMER}\n\nUse the button below or run \`/event-carpools\` to create one post per trip.`,
      },
      name: 'Start here',
    }),
    method: 'POST',
  });
}

async function createEventCarpoolForumThread(
  env: Env,
  forum: DiscordForumChannel,
  event: EventCarpoolProjection,
) {
  return discordApiRequest<DiscordForumThreadResult>(
    env,
    `/channels/${forum.id}/threads`,
    {
      body: JSON.stringify({
        applied_tags: compact([findStatusTag(forum, statusTagName(event))]),
        auto_archive_duration: 10_080,
        message: createEventCarpoolMessagePayload(event),
        name: event.title.slice(0, 100),
      }),
      method: 'POST',
    },
  );
}

function createEventCarpoolModal(): DiscordMessagePayload {
  return {
    components: [
      textInput(
        EVENT_CARPOOL_TITLE_INPUT,
        'Event or trip name',
        'Grissom aviation day',
        2,
        100,
      ),
      textInput(
        EVENT_CARPOOL_DESTINATION_INPUT,
        'Destination',
        'Grissom Air Museum',
        2,
        200,
      ),
      textInput(
        EVENT_CARPOOL_MEETING_POINT_INPUT,
        'Meeting point',
        'Purdue Memorial Union',
        2,
        200,
      ),
      textInput(
        EVENT_CARPOOL_DEPARTS_AT_INPUT,
        'Departure (local time)',
        'YYYY-MM-DD HH:MM',
        16,
        16,
      ),
      textInput(
        EVENT_CARPOOL_RETURNS_AT_INPUT,
        'Expected return (local time)',
        'YYYY-MM-DD HH:MM',
        16,
        16,
      ),
    ],
    custom_id: EVENT_CARPOOL_CREATE_MODAL_CUSTOM_ID,
    title: 'Create event carpool',
  };
}

function createDriverModal(eventId: string): DiscordMessagePayload {
  return {
    components: [
      textInput(
        EVENT_CARPOOL_SEATS_INPUT,
        'Passenger seats',
        '1–8, excluding you',
        1,
        1,
      ),
      textInput(
        EVENT_CARPOOL_NOTE_INPUT,
        'Pickup note (optional)',
        'Optional public meetup note',
        0,
        300,
        false,
        PARAGRAPH_TEXT,
      ),
    ],
    custom_id: `${EVENT_CARPOOL_DRIVER_MODAL_PREFIX}${eventId}`,
    title: 'Offer passenger seats',
  };
}

function textInput(
  customId: string,
  label: string,
  placeholder: string,
  minLength: number,
  maxLength: number,
  required = true,
  style = SHORT_TEXT,
) {
  return {
    component: {
      custom_id: customId,
      max_length: maxLength,
      min_length: minLength,
      placeholder,
      required,
      style,
      type: TEXT_INPUT,
    },
    label,
    type: LABEL,
  };
}

function parseEventCarpoolButton(customId: string) {
  if (customId === EVENT_CARPOOL_CREATE_CUSTOM_ID) {
    return { action: 'create' as const, eventId: '' };
  }
  if (!customId.startsWith(EVENT_CARPOOL_CUSTOM_ID_PREFIX)) return null;
  const [action, eventId] = customId
    .slice(EVENT_CARPOOL_CUSTOM_ID_PREFIX.length)
    .split(':');
  if (
    !eventId ||
    !UUID_PATTERN.test(eventId) ||
    (action !== 'drive' &&
      action !== 'ride' &&
      action !== 'withdraw' &&
      action !== 'assign' &&
      action !== 'reopen' &&
      action !== 'cancel')
  )
    return null;
  return { action, eventId } as {
    action: 'assign' | 'cancel' | 'drive' | 'reopen' | 'ride' | 'withdraw';
    eventId: string;
  };
}

function parseEventCarpoolDriverModalId(customId: string) {
  if (!customId.startsWith(EVENT_CARPOOL_DRIVER_MODAL_PREFIX)) return null;
  const eventId = customId.slice(EVENT_CARPOOL_DRIVER_MODAL_PREFIX.length);
  return UUID_PATTERN.test(eventId) ? eventId : null;
}

function readModalValues(interaction: ModalSubmitInteraction) {
  const values = new Map<string, string>();
  for (const row of interaction.data.components ?? []) {
    if (!isRecord(row)) continue;
    const components = [
      ...(isRecord(row.component) ? [row.component] : []),
      ...(Array.isArray(row.components) ? row.components : []),
    ];
    for (const component of components) {
      if (
        isRecord(component) &&
        typeof component.custom_id === 'string' &&
        typeof component.value === 'string'
      )
        values.set(component.custom_id, component.value.trim());
    }
  }
  return values;
}

function readActorDiscordId(interaction: {
  member?: { user?: { id?: string } };
  user?: { id?: string };
}) {
  const id = interaction.member?.user?.id ?? interaction.user?.id;
  return id && SNOWFLAKE_PATTERN.test(id) ? id : null;
}

function isEventCarpoolStaff(interaction: { member?: { roles?: string[] } }) {
  const roles = interaction.member?.roles ?? [];
  return (
    roles.includes(DISCORD_ROLE_IDS.executive) ||
    roles.includes(DISCORD_ROLE_IDS.admin)
  );
}

function readEventCarpoolError(error: unknown) {
  if (error instanceof AppError && isRecord(error.details)) {
    const apiError = error.details.error;
    if (typeof apiError === 'string' && apiError.trim()) return apiError;
  }
  return getErrorMessage(error);
}

function requireSnowflake(value: unknown, label: string) {
  if (typeof value !== 'string' || !SNOWFLAKE_PATTERN.test(value)) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

function compact(values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
