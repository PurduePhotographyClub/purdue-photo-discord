import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
} from 'discord-interactions';
import type {
  ComponentInteraction,
  Env,
  ModalSubmitInteraction,
} from '../discord/types';
import {
  deferDiscordInteraction,
  shouldDeferDiscordInteraction,
} from '../routes/discordInteractions';
import {
  handleDarkroomScheduleDropButton,
  handleDarkroomScheduleJoinSelect,
  handleDarkroomScheduleSessionActionButton,
} from './discordDarkroomScheduleService';
import { handleEquipmentLoanActionButton } from './discordEquipmentLoanService';
import {
  handleFilmRequestReviewButton,
  handleFilmRequestReviewModalSubmit,
} from './discordFilmRequestService';
import {
  handleStudioModalSubmit,
  handleStudioReviewButton,
} from './discordStudioScheduleService';

const originalFetch = globalThis.fetch;
const TEST_INTERACTION_TOKEN = ['interaction', 'token'].join('-');

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('darkroom scoped managers reach API authorization without an Executive role pre-gate', async () => {
  const apiRequests: Request[] = [];
  const response = await handleDarkroomScheduleSessionActionButton(
    componentInteraction('darkroom_schedule_end:slot-123'),
    apiEnv(async (request) => {
      apiRequests.push(request);
      return Response.json({
        action: 'end',
        message: 'Darkroom session ended.',
        ok: true,
      });
    }),
  );

  assert.equal(apiRequests.length, 1);
  assert.equal(
    new URL(apiRequests[0]!.url).pathname,
    '/api/v1/darkroom/schedule/slot-123/session-by-discord',
  );
  assert.deepEqual(await apiRequests[0]!.clone().json(), {
    action: 'end',
    discordId: 'scoped-manager',
  });
  assert.equal(
    response.type,
    InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
  );
  assert.equal(response.data?.content, 'Darkroom session ended.');
});

test('studio scoped managers can open and submit review modals before API authorization', async () => {
  const buttonResponse = handleStudioReviewButton(
    componentInteraction('studio_review:approve:request-123'),
  );
  assert.equal(buttonResponse.type, InteractionResponseType.MODAL);

  const apiRequests: Request[] = [];
  const submitResponse = await handleStudioModalSubmit(
    {
      ...componentInteraction('studio_review_modal:approve:request-123'),
      data: {
        components: [],
        custom_id: 'studio_review_modal:approve:request-123',
      },
    } as ModalSubmitInteraction,
    apiEnv(async (request) => {
      apiRequests.push(request);
      return Response.json({ message: 'Studio request approved.', ok: true });
    }),
  );

  assert.equal(apiRequests.length, 1);
  assert.equal(
    new URL(apiRequests[0]!.url).pathname,
    '/api/v1/admin/studio/request-123/review-by-discord',
  );
  assert.deepEqual(await apiRequests[0]!.clone().json(), {
    action: 'approve',
    adminNote: '',
    discordId: 'scoped-manager',
  });
  assert.equal(submitResponse.data?.content, 'Studio request approved.');
});

test('darkroom scoped managers can open and submit film review modals before API authorization', async () => {
  const buttonResponse = handleFilmRequestReviewButton(
    componentInteraction('film_request_review:fulfill:film-request-123'),
  );
  assert.equal(buttonResponse.type, InteractionResponseType.MODAL);

  const apiRequests: Request[] = [];
  const submitResponse = await handleFilmRequestReviewModalSubmit(
    {
      ...componentInteraction(
        'film_request_review_modal:fulfill:film-request-123',
      ),
      data: {
        components: [],
        custom_id: 'film_request_review_modal:fulfill:film-request-123',
      },
    } as ModalSubmitInteraction,
    apiEnv(async (request) => {
      apiRequests.push(request);
      return Response.json({ message: 'Film request accepted.', ok: true });
    }),
  );

  assert.equal(apiRequests.length, 1);
  assert.equal(
    new URL(apiRequests[0]!.url).pathname,
    '/api/v1/admin/darkroom/film-requests/film-request-123/review-by-discord',
  );
  assert.deepEqual(await apiRequests[0]!.clone().json(), {
    action: 'fulfill',
    adminNote: null,
    discordId: 'scoped-manager',
  });
  assert.equal(submitResponse.data?.content, 'Film request accepted.');
});

test('equipment actions continue to rely on API authorization for scoped managers', async () => {
  const apiRequests: Request[] = [];
  const response = await handleEquipmentLoanActionButton(
    componentInteraction('equipment_loan:return:loan-123'),
    apiEnv(async (request) => {
      apiRequests.push(request);
      return Response.json({ message: 'Return marked ready.', ok: true });
    }),
  );

  assert.equal(apiRequests.length, 1);
  assert.equal(
    new URL(apiRequests[0]!.url).pathname,
    '/api/v1/loans/loan-123/action-by-discord',
  );
  assert.deepEqual(await apiRequests[0]!.clone().json(), {
    action: 'return',
    discordId: 'scoped-manager',
  });
  assert.equal(response.data?.content, 'Return marked ready.');
});

test('darkroom mutations acknowledge ephemerally before the API and Discord sync finish', async () => {
  let resolveApiResponse: ((response: Response) => void) | undefined;
  const apiResponse = new Promise<Response>((resolve) => {
    resolveApiResponse = resolve;
  });
  let backgroundWork: Promise<unknown> | undefined;
  const webhookRequests: Array<{
    body: unknown;
    method: string;
    path: string;
  }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    webhookRequests.push({
      body: init?.body ? JSON.parse(String(init.body)) : null,
      method: init?.method ?? 'GET',
      path: url.pathname,
    });
    return Response.json({ id: 'original-response' });
  };

  const interaction = {
    ...componentInteraction('darkroom_schedule_drop:slot-123'),
    application_id: 'application-123',
    token: TEST_INTERACTION_TOKEN,
    type: InteractionType.MESSAGE_COMPONENT,
  };
  const executionContext = {
    waitUntil(promise: Promise<unknown>) {
      backgroundWork = promise;
    },
  } as ExecutionContext;

  assert.equal(shouldDeferDiscordInteraction(interaction), true);
  const acknowledgement = deferDiscordInteraction(
    interaction,
    apiEnv(async () => apiResponse),
    executionContext,
  );

  assert.equal(
    acknowledgement.type,
    InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  );
  assert.equal(
    Number(acknowledgement.data?.flags),
    InteractionResponseFlags.EPHEMERAL,
  );
  assert.ok(
    backgroundWork,
    'deferred work should be registered with waitUntil',
  );
  assert.equal(webhookRequests.length, 0);

  resolveApiResponse?.(
    Response.json({
      dropped: true,
      message: 'You left the darkroom session.',
      ok: true,
      weeklyJoinMessageEvents: [],
    }),
  );
  await backgroundWork;

  assert.deepEqual(webhookRequests, [
    {
      body: {
        allowed_mentions: { parse: [] },
        content: 'You left the darkroom session.',
      },
      method: 'PATCH',
      path: '/api/v10/webhooks/application-123/interaction-token/messages/@original',
    },
  ]);
});

test('slow modal submissions acknowledge before their API request finishes', async () => {
  let resolveApiResponse: ((response: Response) => void) | undefined;
  const apiResponse = new Promise<Response>((resolve) => {
    resolveApiResponse = resolve;
  });
  let backgroundWork: Promise<unknown> | undefined;
  const webhookRequests: Array<{ method: string; path: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    webhookRequests.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
    });
    return Response.json({ id: 'original-response' });
  };

  const interaction = {
    application_id: 'application-123',
    data: {
      components: [],
      custom_id: 'studio_schedule_request_modal',
    },
    member: { roles: [], user: { id: 'scoped-manager' } },
    token: TEST_INTERACTION_TOKEN,
    type: InteractionType.MODAL_SUBMIT,
  } as ModalSubmitInteraction;
  const executionContext = {
    waitUntil(promise: Promise<unknown>) {
      backgroundWork = promise;
    },
  } as ExecutionContext;

  assert.equal(shouldDeferDiscordInteraction(interaction), true);
  const acknowledgement = deferDiscordInteraction(
    interaction,
    apiEnv(async () => apiResponse),
    executionContext,
  );

  assert.equal(
    acknowledgement.type,
    InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  );
  assert.equal(
    Number(acknowledgement.data?.flags),
    InteractionResponseFlags.EPHEMERAL,
  );
  assert.ok(backgroundWork);
  assert.equal(webhookRequests.length, 0);

  resolveApiResponse?.(Response.json({ message: 'Submitted.', ok: true }));
  await backgroundWork;
  assert.deepEqual(webhookRequests, [
    {
      method: 'PATCH',
      path: '/api/v10/webhooks/application-123/interaction-token/messages/@original',
    },
  ]);
});

test('a drop that is stale at preflight converges to the latest rejoin roster', async () => {
  const memberMutations: string[] = [];
  const renderedCapacities: string[] = [];
  const persistenceBodies: Array<Record<string, unknown>> = [];
  let threadName = 'darkroom--pcc-darkroom-slot-123-r1';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (
      method === 'GET' &&
      url.pathname === '/api/v10/channels/darkroom-thread'
    ) {
      return Response.json({
        guild_id: 'guild-123',
        id: 'darkroom-thread',
        name: threadName,
        parent_id: '1512900016979837161',
        type: 12,
      });
    }
    if (
      method === 'PATCH' &&
      url.pathname === '/api/v10/channels/darkroom-thread'
    ) {
      threadName = (body as { name: string }).name;
      return Response.json({ id: 'darkroom-thread' });
    }
    if (
      (method === 'PUT' || method === 'DELETE') &&
      url.pathname ===
        '/api/v10/channels/darkroom-thread/thread-members/member-123'
    ) {
      memberMutations.push(method);
      return new Response(null, { status: 204 });
    }
    if (
      method === 'PUT' &&
      url.pathname ===
        '/api/v10/channels/darkroom-thread/thread-members/manager-123'
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      method === 'DELETE' &&
      url.pathname ===
        '/api/v10/channels/darkroom-thread/thread-members/former-manager-123'
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      method === 'PATCH' &&
      url.pathname === '/api/v10/channels/darkroom-thread/messages/message-123'
    ) {
      const capacity = (
        body as {
          embeds?: Array<{ fields?: Array<{ name: string; value: string }> }>;
        }
      ).embeds?.[0]?.fields?.find((field) => field.name === 'Capacity')?.value;
      if (capacity) renderedCapacities.push(capacity);
      return Response.json({ id: 'message-123' });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  let stateReads = 0;
  const response = await handleDarkroomScheduleDropButton(
    componentInteraction('darkroom_schedule_drop:slot-123'),
    {
      API_WORKER: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (
            url.pathname ===
            '/api/v1/darkroom/schedule/slot-123/drop-by-discord'
          ) {
            return Response.json({
              dropped: true,
              message: 'Dropped.',
              ok: true,
              syncEvent: darkroomSyncEvent(2, false),
              weeklyJoinMessageEvents: [],
            });
          }
          if (
            url.pathname ===
            '/api/v1/darkroom/schedule/slot-123/discord-sync-state'
          ) {
            stateReads += 1;
            return Response.json({
              discordSyncStatus: 'pending',
              status: 'open',
              syncRevision: 3,
            });
          }
          if (
            url.pathname ===
            '/api/v1/darkroom/schedule/slot-123/sync-result-by-discord'
          ) {
            const body = (await request.json()) as { syncRevision: number };
            persistenceBodies.push(body);
            return body.syncRevision === 2
              ? Response.json({
                  ok: true,
                  stale: true,
                  syncEvent: darkroomSyncEvent(3, true),
                })
              : Response.json({ ok: true, stale: false });
          }
          throw new Error(`Unexpected API Worker request: ${url.pathname}`);
        },
      } as unknown as Fetcher,
      DISCORD_APPLICATION_ID: 'application-123',
      DISCORD_GUILD_ID: 'guild-123',
      DISCORD_TOKEN: 'discord-token',
    },
  );

  assert.equal(response.data?.content, 'Dropped.');
  assert.deepEqual(memberMutations, ['PUT']);
  assert.equal(threadName.endsWith('-r3'), true);
  assert.equal(stateReads, 2);
  assert.deepEqual(renderedCapacities, ['1/4']);
  assert.deepEqual(
    persistenceBodies.map((body) => body.syncRevision),
    [2, 3],
  );
  assert.deepEqual(
    persistenceBodies.map((body) => body.removeManagerDiscordIds),
    [['former-manager-123'], ['former-manager-123']],
  );
});

test('a rejoin retries only the rate-limited root message edit', async () => {
  const memberMutations: string[] = [];
  const mutationOrder: string[] = [];
  const renderedCapacities: string[] = [];
  let messagePatchCount = 0;
  let persistenceCount = 0;
  let threadName = 'darkroom--pcc-darkroom-slot-123-r2';

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (
      method === 'GET' &&
      url.pathname === '/api/v10/channels/darkroom-thread'
    ) {
      return Response.json({
        guild_id: 'guild-123',
        id: 'darkroom-thread',
        name: threadName,
        parent_id: '1512900016979837161',
        type: 12,
      });
    }
    if (
      method === 'PATCH' &&
      url.pathname === '/api/v10/channels/darkroom-thread'
    ) {
      threadName = (body as { name: string }).name;
      return Response.json({ id: 'darkroom-thread' });
    }
    if (
      method === 'PUT' &&
      url.pathname ===
        '/api/v10/channels/darkroom-thread/thread-members/member-123'
    ) {
      memberMutations.push(method);
      mutationOrder.push('member');
      return new Response(null, { status: 204 });
    }
    if (
      method === 'PUT' &&
      url.pathname ===
        '/api/v10/channels/darkroom-thread/thread-members/manager-123'
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      method === 'DELETE' &&
      url.pathname ===
        '/api/v10/channels/darkroom-thread/thread-members/former-manager-123'
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      method === 'PATCH' &&
      url.pathname === '/api/v10/channels/darkroom-thread/messages/message-123'
    ) {
      messagePatchCount += 1;
      mutationOrder.push('message');
      const capacity = (
        body as {
          embeds?: Array<{ fields?: Array<{ name: string; value: string }> }>;
        }
      ).embeds?.[0]?.fields?.find((field) => field.name === 'Capacity')?.value;
      if (capacity) renderedCapacities.push(capacity);
      return messagePatchCount === 1
        ? Response.json(
            { retry_after: 0.75 },
            { headers: { 'Retry-After': '0.75' }, status: 429 },
          )
        : Response.json({ id: 'message-123' });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  const response = await handleDarkroomScheduleJoinSelect(
    {
      ...componentInteraction('darkroom_schedule_join'),
      data: {
        component_type: MessageComponentTypes.STRING_SELECT,
        custom_id: 'darkroom_schedule_join',
        values: ['slot-123'],
      },
    } as ComponentInteraction,
    {
      API_WORKER: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname.endsWith('/join-by-discord')) {
            return Response.json({
              joined: true,
              message: 'Joined.',
              ok: true,
              syncEvent: darkroomSyncEvent(3, true),
              weeklyJoinMessageEvents: [],
            });
          }
          if (url.pathname.endsWith('/discord-sync-state')) {
            return Response.json({
              discordSyncStatus: 'pending',
              status: 'open',
              syncRevision: 3,
            });
          }
          if (url.pathname.endsWith('/sync-result-by-discord')) {
            persistenceCount += 1;
            return Response.json({ ok: true, stale: false });
          }
          throw new Error(`Unexpected API Worker request: ${url.pathname}`);
        },
      } as unknown as Fetcher,
      DISCORD_APPLICATION_ID: 'application-123',
      DISCORD_GUILD_ID: 'guild-123',
      DISCORD_TOKEN: 'discord-token',
    },
  );

  assert.equal(response.data?.content, 'Joined.');
  assert.deepEqual(memberMutations, ['PUT']);
  assert.deepEqual(renderedCapacities, ['1/4', '1/4']);
  assert.equal(messagePatchCount, 2);
  assert.equal(persistenceCount, 1);
  assert.equal(threadName.endsWith('-r3'), true);
  assert.deepEqual(mutationOrder, ['member', 'message', 'message']);
});

test('a rejoin does not repost a missing root message while retrying member access', async () => {
  let memberPutCount = 0;
  let messagePostCount = 0;
  let persistenceCount = 0;
  let threadName = 'darkroom--pcc-darkroom-slot-123-r2';

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (
      method === 'GET' &&
      url.pathname === '/api/v10/channels/darkroom-thread'
    ) {
      return Response.json({
        guild_id: 'guild-123',
        id: 'darkroom-thread',
        name: threadName,
        parent_id: '1512900016979837161',
        type: 12,
      });
    }
    if (
      method === 'PATCH' &&
      url.pathname === '/api/v10/channels/darkroom-thread'
    ) {
      threadName = (body as { name: string }).name;
      return Response.json({ id: 'darkroom-thread' });
    }
    if (
      method === 'PATCH' &&
      url.pathname === '/api/v10/channels/darkroom-thread/messages/message-123'
    ) {
      return Response.json({ message: 'Unknown Message' }, { status: 404 });
    }
    if (
      method === 'POST' &&
      url.pathname === '/api/v10/channels/darkroom-thread/messages'
    ) {
      messagePostCount += 1;
      return Response.json({ id: 'replacement-message' });
    }
    if (
      method === 'PUT' &&
      url.pathname ===
        '/api/v10/channels/darkroom-thread/thread-members/member-123'
    ) {
      memberPutCount += 1;
      return memberPutCount === 1
        ? Response.json(
            { retry_after: 0.501 },
            { headers: { 'Retry-After': '0.501' }, status: 429 },
          )
        : new Response(null, { status: 204 });
    }
    if (
      (method === 'PUT' &&
        url.pathname ===
          '/api/v10/channels/darkroom-thread/thread-members/manager-123') ||
      (method === 'DELETE' &&
        url.pathname ===
          '/api/v10/channels/darkroom-thread/thread-members/former-manager-123')
    ) {
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  const response = await handleDarkroomScheduleJoinSelect(
    {
      ...componentInteraction('darkroom_schedule_join'),
      data: {
        component_type: MessageComponentTypes.STRING_SELECT,
        custom_id: 'darkroom_schedule_join',
        values: ['slot-123'],
      },
    } as ComponentInteraction,
    {
      API_WORKER: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname.endsWith('/join-by-discord')) {
            return Response.json({
              joined: true,
              message: 'Joined.',
              ok: true,
              syncEvent: darkroomSyncEvent(3, true),
              weeklyJoinMessageEvents: [],
            });
          }
          if (url.pathname.endsWith('/discord-sync-state')) {
            return Response.json({
              discordSyncStatus: 'pending',
              status: 'open',
              syncRevision: 3,
            });
          }
          if (url.pathname.endsWith('/sync-result-by-discord')) {
            persistenceCount += 1;
            return Response.json({ ok: true, stale: false });
          }
          throw new Error(`Unexpected API Worker request: ${url.pathname}`);
        },
      } as unknown as Fetcher,
      DISCORD_APPLICATION_ID: 'application-123',
      DISCORD_GUILD_ID: 'guild-123',
      DISCORD_TOKEN: 'discord-token',
    },
  );

  assert.equal(response.data?.content, 'Joined.');
  assert.equal(messagePostCount, 1);
  assert.equal(memberPutCount, 2);
  assert.equal(persistenceCount, 1);
  assert.equal(threadName.endsWith('-r3'), true);
});

test('an older weekly drop refresh cannot overwrite a newer rejoin refresh', async () => {
  const weeklyMessageId = '777777777777777777';
  const weeklyChannelId = '1512900016979837161';
  const completedCounts: number[] = [];
  let patchCount = 0;
  let releaseDropPatch: (() => void) | undefined;
  let dropPatchStarted: (() => void) | undefined;
  const dropPatchReady = new Promise<void>((resolve) => {
    dropPatchStarted = resolve;
  });
  const holdDropPatch = new Promise<void>((resolve) => {
    releaseDropPatch = resolve;
  });

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (
      method !== 'PATCH' ||
      url.pathname !==
        `/api/v10/channels/${weeklyChannelId}/messages/${weeklyMessageId}`
    ) {
      throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
    }

    const body = JSON.parse(String(init?.body)) as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    const openSlots = body.embeds[0]?.fields.find(
      (field) => field.name === 'Open slots',
    )?.value;
    const registeredCount = openSlots?.includes('(1/4)') ? 1 : 0;
    patchCount += 1;
    if (patchCount === 1) {
      dropPatchStarted?.();
      await holdDropPatch;
    }
    completedCounts.push(registeredCount);
    return Response.json({ id: weeklyMessageId });
  };

  const env: Env = {
    ...apiEnv(async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith('/drop-by-discord')) {
        return Response.json({
          dropped: true,
          message: 'Dropped.',
          ok: true,
          weeklyJoinMessageEvents: [weeklyJoinEvent(0)],
        });
      }
      if (pathname.endsWith('/join-by-discord')) {
        return Response.json({
          joined: true,
          message: 'Joined.',
          ok: true,
          weeklyJoinMessageEvents: [weeklyJoinEvent(1)],
        });
      }
      if (pathname.endsWith('/weekly-message-sync-result-by-discord')) {
        const body = (await request.json()) as { projectionHash: string };
        return body.projectionHash === 'a'.repeat(64)
          ? Response.json({
              ok: true,
              stale: true,
              syncEvent: weeklyJoinEvent(1),
            })
          : Response.json({ ok: true, stale: false });
      }
      throw new Error(`Unexpected API Worker request: ${pathname}`);
    }),
    DISCORD_TOKEN: 'discord-token',
  };

  const dropPromise = handleDarkroomScheduleDropButton(
    componentInteraction('darkroom_schedule_drop:slot-123'),
    env,
  );
  await dropPatchReady;
  const joinResponse = await handleDarkroomScheduleJoinSelect(
    {
      ...componentInteraction('darkroom_schedule_join'),
      channel_id: weeklyChannelId,
      data: {
        component_type: MessageComponentTypes.STRING_SELECT,
        custom_id: 'darkroom_schedule_join',
        values: ['slot-123'],
      },
      message: { id: weeklyMessageId },
    } as ComponentInteraction,
    env,
  );
  releaseDropPatch?.();
  const dropResponse = await dropPromise;

  assert.equal(joinResponse.data?.content, 'Joined.');
  assert.equal(dropResponse.data?.content, 'Dropped.');
  assert.deepEqual(
    completedCounts,
    [1, 0, 1],
    'the stale drop must trigger one bounded repair with the latest rejoin projection',
  );
});

test('joining from a weekly menu cannot retarget tracked coordinates from the interaction source', async () => {
  const sourceChannelId = '1512900016979837161';
  const sourceMessageId = '888888888888888888';
  const callbackBodies: unknown[] = [];
  const unboundEvent = {
    ...weeklyJoinEvent(1),
    channelId: undefined,
    messageId: undefined,
  };

  globalThis.fetch = async () => {
    throw new Error('An unbound API projection must not target Discord.');
  };

  const env: Env = {
    ...apiEnv(async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith('/join-by-discord')) {
        return Response.json({
          joined: true,
          message: 'Joined.',
          ok: true,
          weeklyJoinMessageEvents: [unboundEvent],
        });
      }
      if (pathname.endsWith('/weekly-message-sync-result-by-discord')) {
        callbackBodies.push(await request.json());
        return Response.json({ ok: true, stale: false });
      }
      throw new Error(`Unexpected API Worker request: ${pathname}`);
    }),
    DISCORD_TOKEN: 'discord-token',
  };

  const response = await handleDarkroomScheduleJoinSelect(
    {
      ...componentInteraction('darkroom_schedule_join'),
      channel_id: sourceChannelId,
      data: {
        component_type: MessageComponentTypes.STRING_SELECT,
        custom_id: 'darkroom_schedule_join',
        values: ['slot-123'],
      },
      message: { id: sourceMessageId },
    } as ComponentInteraction,
    env,
  );

  assert.equal(
    response.data?.content,
    'Joined. Some Discord views may take a moment to catch up.',
  );
  assert.deepEqual(callbackBodies, []);
});

test('only long-running commands and darkroom components are selected for deferred handling', () => {
  for (const customId of [
    'darkroom_schedule_join',
    'darkroom_schedule_drop:slot-123',
    'darkroom_schedule_end:slot-123',
    'darkroom_schedule_cancel:slot-123',
    'equipment_terms:accept',
    'equipment_terms:deny',
    'equipment_loan:return:loan-123',
    'studio_cancel:request-123',
  ]) {
    assert.equal(
      shouldDeferDiscordInteraction({
        ...componentInteraction(customId),
        type: InteractionType.MESSAGE_COMPONENT,
      }),
      true,
    );
  }
  for (const customId of [
    'studio_schedule_book',
    'studio_cancel_next',
    'studio_review:approve:request-123',
    'film_request_review:fulfill:request-123',
  ]) {
    assert.equal(
      shouldDeferDiscordInteraction({
        ...componentInteraction(customId),
        type: InteractionType.MESSAGE_COMPONENT,
      }),
      false,
    );
  }
  for (const customId of [
    'studio_schedule_request_modal',
    'studio_cancel_modal',
    'studio_review_modal:approve:request-123',
    'film_request_review_modal:fulfill:request-123',
  ]) {
    assert.equal(
      shouldDeferDiscordInteraction({
        data: { custom_id: customId },
        type: InteractionType.MODAL_SUBMIT,
      }),
      true,
    );
  }
  for (const name of [
    'studio-message',
    'darkroom-stats',
    'equipment-terms-message',
  ]) {
    assert.equal(
      shouldDeferDiscordInteraction({
        data: { name },
        type: InteractionType.APPLICATION_COMMAND,
      }),
      true,
    );
  }
  assert.equal(
    shouldDeferDiscordInteraction({
      data: { name: 'admin' },
      type: InteractionType.APPLICATION_COMMAND,
    }),
    false,
  );
});

function componentInteraction(customId: string): ComponentInteraction {
  return {
    data: {
      component_type: MessageComponentTypes.BUTTON,
      custom_id: customId,
    },
    member: {
      roles: [],
      user: { id: 'scoped-manager' },
    },
    type: InteractionType.MESSAGE_COMPONENT,
  };
}

function apiEnv(fetcher: (request: Request) => Promise<Response>): Env {
  return {
    API_WORKER: {
      fetch: fetcher,
    } as unknown as Fetcher,
  };
}

function darkroomSyncEvent(syncRevision: number, registered: boolean) {
  return {
    capacity: 4,
    channelId: 'darkroom-thread',
    endsAt: '2099-07-21T14:00:00.000Z',
    managerDiscordIds: ['manager-123'],
    messageId: 'message-123',
    registeredCount: registered ? 1 : 0,
    registrants: registered
      ? [
          {
            discordId: 'member-123',
            name: 'Member',
            registeredAt: '2099-07-20T12:00:00.000Z',
            userId: 'user-123',
          },
        ]
      : [],
    removeDiscordIds: ['member-123'],
    removeManagerDiscordIds: ['former-manager-123'],
    slotId: 'slot-123',
    startsAt: '2099-07-21T12:00:00.000Z',
    status: 'open' as const,
    syncRevision,
    title: 'Open Darkroom',
    type: 'website.darkroom.schedule.sync' as const,
  };
}

function weeklyJoinEvent(registeredCount: number) {
  return {
    allowCreate: false,
    channelId: '1512900016979837161',
    messageId: '777777777777777777',
    projectionHash: registeredCount === 0 ? 'a'.repeat(64) : 'b'.repeat(64),
    projectionRevision: registeredCount === 0 ? 1 : 2,
    slots: [
      {
        availableCapacity: 4 - registeredCount,
        capacity: 4,
        endsAt: '2099-07-21T14:00:00.000Z',
        registeredCount,
        slotId: 'slot-123',
        startsAt: '2099-07-21T12:00:00.000Z',
        title: 'Open Darkroom',
      },
    ],
    type: 'website.darkroom.schedule.weekly_join_message' as const,
    weeklyMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    windowEnd: '2099-07-27T04:00:00.000Z',
    windowStart: '2099-07-20T04:00:00.000Z',
  };
}
