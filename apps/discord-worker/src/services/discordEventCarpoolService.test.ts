import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
} from 'discord-interactions';
import { getCommand } from '../../config/commands';
import { handleButtonInteraction } from '../components/buttons';
import { handleModalSubmitInteraction } from '../components/modals';
import type {
  ApplicationCommandInteraction,
  ComponentInteraction,
  Env,
  ModalSubmitInteraction,
} from '../discord/types';
import { dispatchInternalEvent } from '../internal-events/dispatcher';
import { parseInternalEvent } from '../internal-events/parser';
import { shouldDeferDiscordInteraction } from '../routes/discordInteractions';
import {
  EVENT_CARPOOL_CREATE_MODAL_CUSTOM_ID,
  createEventCarpoolMessagePayload,
  type EventCarpoolProjection,
} from './discordEventCarpoolService';

const originalFetch = globalThis.fetch;
const ACTOR_ID = '123456789012345678';
const INTERACTION_ID = '223456789012345678';
const GUILD_ID = '323456789012345678';
const FORUM_ID = '423456789012345678';
const THREAD_ID = '523456789012345678';
const EVENT_ID = '213f0818-b135-4a1f-9708-46eb5220b979';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('/event-carpools is registered and opens a five-field event modal', async () => {
  const command = getCommand('event-carpools');
  assert.ok(command);
  const response = await command.execute(commandInteraction(), createEnv());

  assert.equal(response.type, InteractionResponseType.MODAL);
  assert.equal(response.data?.custom_id, EVENT_CARPOOL_CREATE_MODAL_CUSTOM_ID);
  assert.equal(response.data?.title, 'Create event carpool');
  assert.equal(response.data?.components?.length, 5);
  assert.equal(shouldDeferDiscordInteraction(commandInteraction()), false);
});

test('open carpool projection renders safe controls, capacity, and disclaimer', () => {
  const payload = createEventCarpoolMessagePayload(openProjection());
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.content ?? '', /not an official PPC activity/i);
  assert.match(JSON.stringify(payload.embeds), /1 more passenger seat/);
  assert.match(JSON.stringify(payload.components), /Offer seats/);
  assert.match(JSON.stringify(payload.components), /Need a ride/);
  assert.match(JSON.stringify(payload.components), /Assign riders/);
});

test('create modal stores local values, creates a forum post, then persists Discord IDs', async () => {
  const apiRequests: Array<{ body: unknown; path: string }> = [];
  const discordRequests: Array<{
    body: unknown;
    method: string;
    path: string;
  }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    discordRequests.push({ body, method, path: url.pathname });
    if (method === 'GET') {
      return Response.json([
        {
          available_tags: [
            { id: '623456789012345678', name: 'Open' },
            { id: '723456789012345678', name: 'Needs drivers' },
            { id: '823456789012345678', name: 'Assigned' },
            { id: '923456789012345678', name: 'Cancelled' },
            { id: '103456789012345678', name: 'Past' },
          ],
          id: FORUM_ID,
          name: 'event-carpools',
          type: 15,
        },
      ]);
    }
    return Response.json({ id: THREAD_ID, message: { id: THREAD_ID } });
  };
  const env = createEnv(async (request) => {
    const path = new URL(request.url).pathname;
    const body = request.body ? await request.json() : undefined;
    apiRequests.push({ body, path });
    return Response.json(
      {
        eventCarpool: path.endsWith('discord-sync-result-by-discord')
          ? { ...openProjection(), syncRevision: 1 }
          : openProjection('provisioning'),
        ok: true,
      },
      { status: path.endsWith('/by-discord') ? 201 : 200 },
    );
  });

  const response = await handleModalSubmitInteraction(
    createModalInteraction(),
    env,
  );

  assert.equal(
    response.data?.content,
    `Event carpool created: <#${THREAD_ID}>`,
  );
  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
  assert.deepEqual(
    apiRequests.map((request) => request.path),
    [
      '/api/v1/event-carpools/by-discord',
      `/api/v1/event-carpools/${EVENT_ID}/discord-sync-result-by-discord`,
    ],
  );
  assert.deepEqual(apiRequests[0]?.body, {
    actorDiscordId: ACTOR_ID,
    departsAtLocal: '2026-08-22 09:30',
    destination: 'Grissom Air Museum',
    interactionId: INTERACTION_ID,
    meetingPoint: 'Purdue Memorial Union',
    returnsAtLocal: '2026-08-22 19:00',
    title: 'Grissom aviation day',
  });
  assert.equal(
    discordRequests[1]?.path,
    `/api/v10/channels/${FORUM_ID}/threads`,
  );
  assert.equal((apiRequests[1]?.body as { isStaff?: unknown }).isStaff, false);
  assert.deepEqual(
    (discordRequests[1]?.body as { message?: { allowed_mentions?: unknown } })
      .message?.allowed_mentions,
    { parse: [] },
  );
  assert.equal(shouldDeferDiscordInteraction(createModalInteraction()), true);
});

test('assignment shortage returns the exact seat count and remains deferred', async () => {
  const env = createEnv(async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/discord-sync-state')) {
      return Response.json({ eventCarpool: openProjection(), ok: true });
    }
    return Response.json(
      {
        code: 'insufficient_event_carpool_seats',
        error:
          'This carpool still needs 1 more passenger seat(s) before riders can be assigned.',
        eventCarpool: openProjection(),
        missingSeats: 1,
        ok: false,
      },
      { status: 409 },
    );
  });
  const interaction = componentInteraction(
    `event_carpool:v1:assign:${EVENT_ID}`,
  );
  const response = await handleButtonInteraction(interaction, env);

  assert.equal(
    response.data?.content,
    'This carpool still needs 1 more passenger seat(s) before riders can be assigned.',
  );
  assert.equal(shouldDeferDiscordInteraction(interaction), true);
});

test('rider signup skips the sync-state preflight and records the Discord projection result', async () => {
  const apiPaths: string[] = [];
  const discordPaths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    discordPaths.push(path);
    if ((init?.method ?? 'GET') === 'GET') {
      return Response.json({
        available_tags: [{ id: '623456789012345678', name: 'Needs drivers' }],
        id: FORUM_ID,
        type: 15,
      });
    }
    return Response.json({ id: THREAD_ID });
  };
  const env = createEnv(async (request) => {
    const path = new URL(request.url).pathname;
    apiPaths.push(path);
    return Response.json({
      eventCarpool: { ...openProjection(), syncRevision: 1 },
      ok: true,
    });
  });

  const response = await handleButtonInteraction(
    componentInteraction(`event_carpool:v1:ride:${EVENT_ID}`),
    env,
  );

  assert.equal(response.data?.content, 'You are signed up as a rider.');
  assert.deepEqual(apiPaths, [
    `/api/v1/event-carpools/${EVENT_ID}/participants/by-discord`,
    `/api/v1/event-carpools/${EVENT_ID}/projection-sync-result-by-discord`,
  ]);
  assert.deepEqual(discordPaths, [
    `/api/v10/channels/${THREAD_ID}/messages/${THREAD_ID}`,
    `/api/v10/channels/${FORUM_ID}`,
    `/api/v10/channels/${THREAD_ID}`,
  ]);
});

test('expiry removes signup details and applies the Past tag while leaving the thread', async () => {
  const requests: Array<{ body: unknown; method: string; path: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ body, method, path: url.pathname });
    if (method === 'GET') {
      return Response.json({
        available_tags: [{ id: '103456789012345678', name: 'Past' }],
        id: FORUM_ID,
        type: 15,
      });
    }
    return Response.json({ id: THREAD_ID });
  };
  const parsed = parseInternalEvent({
    payload: {
      eventId: EVENT_ID,
      forumChannelId: FORUM_ID,
      rootMessageId: THREAD_ID,
      threadId: THREAD_ID,
    },
    type: 'website.event_carpool.expire',
  });
  const result = await dispatchInternalEvent(parsed, createEnv());

  assert.equal(result.ok, true);
  assert.deepEqual(
    requests.map((request) => request.path),
    [
      `/api/v10/channels/${THREAD_ID}/messages/${THREAD_ID}`,
      `/api/v10/channels/${FORUM_ID}`,
      `/api/v10/channels/${THREAD_ID}`,
    ],
  );
  assert.deepEqual(
    (requests[0]?.body as { components?: unknown }).components,
    [],
  );
  assert.match(
    String((requests[0]?.body as { content?: unknown }).content),
    /signup data has been deleted/i,
  );
  assert.deepEqual(
    (requests[2]?.body as { applied_tags?: unknown }).applied_tags,
    ['103456789012345678'],
  );
});

function createEnv(
  apiFetch: (request: Request) => Promise<Response> = async () =>
    Response.json({ ok: true }),
): Env {
  return {
    API_WORKER: { fetch: apiFetch } as Env['API_WORKER'],
    DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_TOKEN: 'test-token',
    INTERNAL_TOKEN: 'test-internal-token',
  };
}

function commandInteraction(): ApplicationCommandInteraction {
  return {
    data: { name: 'event-carpools' },
    guild_id: GUILD_ID,
    id: INTERACTION_ID,
    member: { roles: [], user: { id: ACTOR_ID } },
    type: InteractionType.APPLICATION_COMMAND,
  };
}

function componentInteraction(customId: string): ComponentInteraction {
  return {
    data: { custom_id: customId },
    guild_id: GUILD_ID,
    member: { roles: [], user: { id: ACTOR_ID } },
    type: InteractionType.MESSAGE_COMPONENT,
  };
}

function createModalInteraction(): ModalSubmitInteraction {
  return {
    data: {
      components: [
        inputRow('event_carpool_title', 'Grissom aviation day'),
        inputRow('event_carpool_destination', 'Grissom Air Museum'),
        inputRow('event_carpool_meeting_point', 'Purdue Memorial Union'),
        inputRow('event_carpool_departs_at', '2026-08-22 09:30'),
        inputRow('event_carpool_returns_at', '2026-08-22 19:00'),
      ],
      custom_id: EVENT_CARPOOL_CREATE_MODAL_CUSTOM_ID,
    },
    guild_id: GUILD_ID,
    id: INTERACTION_ID,
    member: { roles: [], user: { id: ACTOR_ID } },
    type: InteractionType.MODAL_SUBMIT,
  };
}

function inputRow(customId: string, value: string) {
  return { components: [{ custom_id: customId, value }] };
}

function openProjection(
  status: 'assigned' | 'cancelled' | 'open' | 'provisioning' = 'open',
): EventCarpoolProjection {
  return {
    assignments: [],
    departsAt: '2026-08-22T13:30:00.000Z',
    destination: 'Grissom Air Museum',
    driverCount: 1,
    forumChannelId: status === 'provisioning' ? null : FORUM_ID,
    id: EVENT_ID,
    meetingPoint: 'Purdue Memorial Union',
    missingSeats: 1,
    offeredSeats: 2,
    organizerDiscordId: ACTOR_ID,
    participants: [
      {
        discordId: '623456789012345678',
        joinedAt: '2026-08-20T12:00:00.000Z',
        note: null,
        offeredSeats: 2,
        role: 'driver',
      },
      {
        discordId: '723456789012345678',
        joinedAt: '2026-08-20T12:01:00.000Z',
        note: null,
        offeredSeats: null,
        role: 'rider',
      },
      {
        discordId: '823456789012345678',
        joinedAt: '2026-08-20T12:02:00.000Z',
        note: null,
        offeredSeats: null,
        role: 'rider',
      },
      {
        discordId: '923456789012345678',
        joinedAt: '2026-08-20T12:03:00.000Z',
        note: null,
        offeredSeats: null,
        role: 'rider',
      },
    ],
    returnsAt: '2026-08-22T23:00:00.000Z',
    riderCount: 3,
    rootMessageId: status === 'provisioning' ? null : THREAD_ID,
    status,
    syncRevision: 0,
    threadId: status === 'provisioning' ? null : THREAD_ID,
    title: 'Grissom aviation day',
  };
}
