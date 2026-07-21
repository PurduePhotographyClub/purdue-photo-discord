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

test('a stale drop sync result converges once to the latest rejoin revision', async () => {
  const memberMutations: string[] = [];
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
              syncRevision: stateReads === 1 ? 2 : 3,
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
  assert.deepEqual(memberMutations, ['DELETE', 'PUT']);
  assert.equal(threadName.endsWith('-r3'), true);
  assert.equal(stateReads, 2);
  assert.deepEqual(
    persistenceBodies.map((body) => body.removeManagerDiscordIds),
    [['former-manager-123'], ['former-manager-123']],
  );
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
