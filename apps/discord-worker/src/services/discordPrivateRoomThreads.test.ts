import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Env } from '../discord/types';
import type {
  DarkroomScheduleSyncInternalEvent,
  EquipmentLoanSyncInternalEvent,
  StudioScheduleSyncInternalEvent,
} from '../internal-events/types';
import { parseInternalEvent } from '../internal-events/parser';
import { syncDarkroomScheduleChannel } from './discordDarkroomScheduleService';
import { syncEquipmentLoanChannel } from './discordEquipmentLoanService';
import { findManagedPrivateThread } from './discordPrivateThreadService';
import { syncStudioScheduleChannel } from './discordStudioScheduleService';

const STUDIO_REQUESTS_CHANNEL_ID = '1513286980518023348';
const DARKROOM_REQUESTS_CHANNEL_ID = '1512900016979837161';
const EQUIPMENT_REQUESTS_CHANNEL_ID = '1517861087947657389';
const originalFetch = globalThis.fetch;

interface RecordedRequest {
  body: unknown;
  method: string;
  pathname: string;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('studio rooms are private non-invitable threads with bot-managed membership', async () => {
  const requests: RecordedRequest[] = [];
  installThreadCreationFetchMock(requests, {
    parentChannelId: STUDIO_REQUESTS_CHANNEL_ID,
    participantIds: ['studio-member'],
    threadId: 'studio-thread',
  });

  const result = await syncStudioScheduleChannel(createEnv(), studioEvent());

  assert.deepEqual(result, {
    channelId: 'studio-thread',
    messageId: 'studio-thread-message',
  });
  assertPrivateThreadCreation(requests, STUDIO_REQUESTS_CHANNEL_ID);
  assert.ok(
    requests.some(
      ({ method, pathname }) =>
        method === 'PUT' &&
        pathname ===
          '/api/v10/channels/studio-thread/thread-members/studio-member',
    ),
  );
  assertNoPermissionOverwriteRequests(requests);
});

test('darkroom rooms reconcile participant additions and removals through thread members', async () => {
  const requests: RecordedRequest[] = [];
  installThreadCreationFetchMock(requests, {
    parentChannelId: DARKROOM_REQUESTS_CHANNEL_ID,
    participantIds: ['darkroom-member'],
    removedParticipantIds: ['former-member'],
    threadId: 'darkroom-thread',
  });

  const result = await syncDarkroomScheduleChannel(
    createEnv(),
    darkroomEvent(),
  );

  assert.deepEqual(result, {
    channelId: 'darkroom-thread',
    messageId: 'darkroom-thread-message',
  });
  assertPrivateThreadCreation(requests, DARKROOM_REQUESTS_CHANNEL_ID);
  assert.ok(
    requests.some(
      ({ method, pathname }) =>
        method === 'DELETE' &&
        pathname ===
          '/api/v10/channels/darkroom-thread/thread-members/former-member',
    ),
  );
  assertNoPermissionOverwriteRequests(requests);
});

test('equipment rooms use the equipment requests channel and add both parties', async () => {
  const requests: RecordedRequest[] = [];
  installThreadCreationFetchMock(requests, {
    parentChannelId: EQUIPMENT_REQUESTS_CHANNEL_ID,
    participantIds: ['borrower', 'lender'],
    threadId: 'equipment-thread',
  });

  const result = await syncEquipmentLoanChannel(createEnv(), equipmentEvent());

  assert.deepEqual(result, {
    channelId: 'equipment-thread',
    messageId: 'equipment-thread-message',
  });
  assertPrivateThreadCreation(requests, EQUIPMENT_REQUESTS_CHANNEL_ID);
  assertNoPermissionOverwriteRequests(requests);
});

test('terminal studio, darkroom, and equipment rooms are deleted instead of archived', async () => {
  const cases = [
    {
      event: {
        ...studioEvent(),
        channelId: 'studio-thread',
        deleteChannel: true,
        messageId: 'studio-message',
        status: 'cancelled' as const,
      },
      marker: '--pcc-studio-studio-request-r1',
      parentChannelId: STUDIO_REQUESTS_CHANNEL_ID,
      sync: syncStudioScheduleChannel,
      threadId: 'studio-thread',
    },
    {
      event: {
        ...darkroomEvent(),
        channelId: 'darkroom-thread',
        deleteChannel: true,
        messageId: 'darkroom-message',
        notificationAction: undefined,
        status: 'cancelled' as const,
      },
      marker: '--pcc-darkroom-darkroom-slot-r1',
      parentChannelId: DARKROOM_REQUESTS_CHANNEL_ID,
      sync: syncDarkroomScheduleChannel,
      threadId: 'darkroom-thread',
    },
    {
      event: {
        ...equipmentEvent(),
        channelId: 'equipment-thread',
        messageId: 'equipment-message',
        returnedAt: '2026-07-21T12:00:00.000Z',
        status: 'returned' as const,
      },
      marker: '--pcc-equipment-equipment-loan-r1',
      parentChannelId: EQUIPMENT_REQUESTS_CHANNEL_ID,
      sync: syncEquipmentLoanChannel,
      threadId: 'equipment-thread',
    },
  ];

  for (const testCase of cases) {
    const requests: RecordedRequest[] = [];
    installThreadDeletionFetchMock(requests, testCase);

    const env =
      testCase.parentChannelId === EQUIPMENT_REQUESTS_CHANNEL_ID
        ? createEnv([{ status: 'returned', syncRevision: 1 }])
        : testCase.parentChannelId === STUDIO_REQUESTS_CHANNEL_ID
          ? createEnv(undefined, {
              studio: [
                {
                  discordSyncStatus: 'pending',
                  status: 'cancelled',
                  syncRevision: 1,
                },
              ],
            })
          : createEnv(undefined, {
              darkroom: [
                {
                  discordSyncStatus: 'pending',
                  status: 'cancelled',
                  syncRevision: 1,
                },
              ],
            });
    const result = await testCase.sync(env, testCase.event as never);

    assert.deepEqual(result, { channelId: null, messageId: null });
    assert.ok(
      requests.some(
        ({ method, pathname }) =>
          method === 'DELETE' &&
          pathname === `/api/v10/channels/${testCase.threadId}`,
      ),
    );
    assert.equal(
      requests.some(
        ({ body, method, pathname }) =>
          method === 'PATCH' &&
          pathname === `/api/v10/channels/${testCase.threadId}` &&
          typeof body === 'object' &&
          body !== null &&
          'parent_id' in body,
      ),
      false,
    );
  }
});

test('managed thread discovery paginates through archived private threads', async () => {
  const archivedRequests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v10/guilds/guild-123/threads/active') {
      return Response.json({ members: [], threads: [] });
    }
    if (
      url.pathname ===
      `/api/v10/channels/${STUDIO_REQUESTS_CHANNEL_ID}/threads/archived/private`
    ) {
      archivedRequests.push(url);
      if (url.searchParams.get('before') === null) {
        return Response.json({
          has_more: true,
          members: [],
          threads: [
            {
              id: 'unrelated-thread',
              name: 'unrelated',
              thread_metadata: {
                archive_timestamp: '2026-07-20T12:00:00.000Z',
              },
            },
          ],
        });
      }

      assert.equal(url.searchParams.get('before'), '2026-07-20T12:00:00.000Z');
      return Response.json({
        has_more: false,
        members: [],
        threads: [
          {
            guild_id: 'guild-123',
            id: 'archived-thread',
            name: 'studio--pcc-studio-request-r7',
            owner_id: 'application-123',
            parent_id: STUDIO_REQUESTS_CHANNEL_ID,
            thread_metadata: {
              archive_timestamp: '2026-07-19T12:00:00.000Z',
              archived: true,
            },
            type: 12,
          },
        ],
      });
    }

    throw new Error(
      `Unexpected Discord API call: ${url.pathname}${url.search}`,
    );
  };

  const thread = await findManagedPrivateThread(createEnv(), {
    marker: '--pcc-studio-request',
    parentChannelId: STUDIO_REQUESTS_CHANNEL_ID,
    syncRevision: 7,
  });

  assert.equal(thread?.id, 'archived-thread');
  assert.equal(archivedRequests.length, 2);
});

test('equipment sync parsing requires revisions and validates every Discord snowflake', () => {
  const basePayload = equipmentParserPayload();

  assert.throws(
    () => parseInternalEvent({ ...basePayload, syncRevision: undefined }),
    /syncRevision must be a non-negative integer/,
  );

  for (const payload of [
    { ...basePayload, channelId: 'not-a-snowflake' },
    { ...basePayload, messageId: 'not-a-snowflake' },
    {
      ...basePayload,
      borrower: { ...basePayload.borrower, discordId: 'not-a-snowflake' },
    },
    {
      ...basePayload,
      lender: { ...basePayload.lender, discordId: 'not-a-snowflake' },
    },
  ]) {
    assert.throws(
      () => parseInternalEvent(payload),
      /must be a Discord snowflake/,
    );
  }
});

test('equipment creation rolls back when the API revision turns terminal mid-sync', async () => {
  const requests: RecordedRequest[] = [];
  installThreadCreationFetchMock(requests, {
    parentChannelId: EQUIPMENT_REQUESTS_CHANNEL_ID,
    participantIds: ['borrower', 'lender'],
    threadId: 'equipment-thread',
  });
  const env = createEnv([
    { status: 'active', syncRevision: 1 },
    { status: 'returned', syncRevision: 2 },
  ]);

  await assert.rejects(
    syncEquipmentLoanChannel(env, equipmentEvent()),
    /Equipment loan Discord sync event is stale/,
  );

  assert.ok(
    requests.some(
      ({ method, pathname }) =>
        method === 'POST' &&
        pathname ===
          `/api/v10/channels/${EQUIPMENT_REQUESTS_CHANNEL_ID}/threads`,
    ),
  );
  assert.ok(
    requests.some(
      ({ method, pathname }) =>
        method === 'DELETE' &&
        pathname === '/api/v10/channels/equipment-thread',
    ),
  );
  assert.equal(
    requests.some(({ pathname }) => pathname.includes('/thread-members/')),
    false,
  );
});

test('stale equipment events cannot mutate an existing private thread', async () => {
  const requests: RecordedRequest[] = [];
  installThreadDeletionFetchMock(requests, {
    marker: '--pcc-equipment-equipment-loan-r1',
    parentChannelId: EQUIPMENT_REQUESTS_CHANNEL_ID,
    threadId: 'equipment-thread',
  });
  const event = {
    ...equipmentEvent(),
    channelId: 'equipment-thread',
    messageId: 'equipment-message',
  };

  await assert.rejects(
    syncEquipmentLoanChannel(
      createEnv([{ status: 'pending_return', syncRevision: 2 }]),
      event,
    ),
    /Equipment loan Discord sync event is stale/,
  );

  assert.equal(
    requests.some(({ method }) => method !== 'GET'),
    false,
  );
});

test('stale studio and darkroom events cannot mutate existing private threads', async () => {
  const cases = [
    {
      event: {
        ...studioEvent(),
        channelId: 'studio-thread',
        messageId: 'studio-message',
      },
      marker: '--pcc-studio-studio-request-r1',
      parentChannelId: STUDIO_REQUESTS_CHANNEL_ID,
      scheduleStates: {
        studio: [
          {
            discordSyncStatus: 'archived',
            status: 'cancelled',
            syncRevision: 2,
          },
        ],
      },
      sync: syncStudioScheduleChannel,
      threadId: 'studio-thread',
    },
    {
      event: {
        ...darkroomEvent(),
        channelId: 'darkroom-thread',
        messageId: 'darkroom-message',
      },
      marker: '--pcc-darkroom-darkroom-slot-r1',
      parentChannelId: DARKROOM_REQUESTS_CHANNEL_ID,
      scheduleStates: {
        darkroom: [
          {
            discordSyncStatus: 'archived',
            status: 'cancelled',
            syncRevision: 2,
          },
        ],
      },
      sync: syncDarkroomScheduleChannel,
      threadId: 'darkroom-thread',
    },
  ];

  for (const testCase of cases) {
    const requests: RecordedRequest[] = [];
    installThreadDeletionFetchMock(requests, testCase);

    await assert.rejects(
      testCase.sync(
        createEnv(undefined, testCase.scheduleStates),
        testCase.event as never,
      ),
      /Discord sync event is stale/,
    );
    assert.equal(
      requests.some(({ method }) => method !== 'GET'),
      false,
    );
  }
});

test('stale darkroom cancellation cannot notify or delete after the slot is reopened', async () => {
  const requests: RecordedRequest[] = [];
  installThreadDeletionFetchMock(requests, {
    marker: '--pcc-darkroom-darkroom-slot-r1',
    parentChannelId: DARKROOM_REQUESTS_CHANNEL_ID,
    threadId: 'darkroom-thread',
  });

  await assert.rejects(
    syncDarkroomScheduleChannel(
      createEnv(undefined, {
        darkroom: [
          {
            discordSyncStatus: 'pending',
            status: 'open',
            syncRevision: 2,
          },
        ],
      }),
      {
        ...darkroomEvent(),
        channelId: 'darkroom-thread',
        deleteChannel: true,
        messageId: 'darkroom-message',
        notificationAction: 'cancel',
        status: 'cancelled',
      },
    ),
    /Darkroom Discord sync event is stale/,
  );

  assert.equal(requests.length, 0);
});

test('studio and darkroom roll back threads created during a terminal transition', async () => {
  const cases = [
    {
      event: studioEvent(),
      parentChannelId: STUDIO_REQUESTS_CHANNEL_ID,
      participantIds: ['studio-member'],
      scheduleStates: {
        studio: [
          {
            discordSyncStatus: 'pending',
            status: 'approved',
            syncRevision: 1,
          },
          {
            discordSyncStatus: 'archived',
            status: 'cancelled',
            syncRevision: 2,
          },
        ],
      },
      sync: syncStudioScheduleChannel,
      threadId: 'studio-thread',
    },
    {
      event: darkroomEvent(),
      parentChannelId: DARKROOM_REQUESTS_CHANNEL_ID,
      participantIds: ['darkroom-member'],
      scheduleStates: {
        darkroom: [
          {
            discordSyncStatus: 'pending',
            status: 'open',
            syncRevision: 1,
          },
          {
            discordSyncStatus: 'archived',
            status: 'cancelled',
            syncRevision: 2,
          },
        ],
      },
      sync: syncDarkroomScheduleChannel,
      threadId: 'darkroom-thread',
    },
  ];

  for (const testCase of cases) {
    const requests: RecordedRequest[] = [];
    installThreadCreationFetchMock(requests, testCase);

    await assert.rejects(
      testCase.sync(
        createEnv(undefined, testCase.scheduleStates),
        testCase.event as never,
      ),
      /Discord sync event is stale/,
    );
    assert.ok(
      requests.some(
        ({ method, pathname }) =>
          method === 'DELETE' &&
          pathname === `/api/v10/channels/${testCase.threadId}`,
      ),
    );
    assert.equal(
      requests.some(({ pathname }) => pathname.includes('/thread-members/')),
      false,
    );
  }
});

function installThreadCreationFetchMock(
  requests: RecordedRequest[],
  options: {
    parentChannelId: string;
    participantIds: string[];
    removedParticipantIds?: string[];
    threadId: string;
  },
) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ body, method, pathname: url.pathname });

    if (
      method === 'GET' &&
      url.pathname === '/api/v10/guilds/guild-123/threads/active'
    ) {
      return Response.json({ members: [], threads: [] });
    }
    if (
      method === 'GET' &&
      url.pathname ===
        `/api/v10/channels/${options.parentChannelId}/threads/archived/private`
    ) {
      return Response.json({ has_more: false, members: [], threads: [] });
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/v10/guilds/guild-123/channels'
    ) {
      return Response.json([]);
    }
    if (
      method === 'POST' &&
      url.pathname === `/api/v10/channels/${options.parentChannelId}/threads`
    ) {
      return Response.json({
        guild_id: 'guild-123',
        id: options.threadId,
        name: (body as { name: string }).name,
        owner_id: 'application-123',
        parent_id: options.parentChannelId,
        thread_metadata: { archived: false },
        type: 12,
      });
    }
    if (
      method === 'PUT' &&
      options.participantIds.some(
        (participantId) =>
          url.pathname ===
          `/api/v10/channels/${options.threadId}/thread-members/${participantId}`,
      )
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      method === 'DELETE' &&
      (options.removedParticipantIds ?? []).some(
        (participantId) =>
          url.pathname ===
          `/api/v10/channels/${options.threadId}/thread-members/${participantId}`,
      )
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      method === 'DELETE' &&
      url.pathname === `/api/v10/channels/${options.threadId}`
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      method === 'POST' &&
      url.pathname === `/api/v10/channels/${options.threadId}/messages`
    ) {
      return Response.json({ id: `${options.threadId}-message` });
    }
    if (method === 'POST' && url.pathname.endsWith('/users/@me/channels')) {
      const recipientId = (body as { recipient_id: string }).recipient_id;
      return Response.json({ id: `dm-${recipientId}` });
    }
    if (
      method === 'POST' &&
      url.pathname.startsWith('/api/v10/channels/dm-') &&
      url.pathname.endsWith('/messages')
    ) {
      return Response.json({ id: 'dm-message' });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };
}

function installThreadDeletionFetchMock(
  requests: RecordedRequest[],
  options: {
    marker: string;
    parentChannelId: string;
    threadId: string;
  },
) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ body, method, pathname: url.pathname });

    if (
      method === 'GET' &&
      url.pathname === `/api/v10/channels/${options.threadId}`
    ) {
      return Response.json({
        guild_id: 'guild-123',
        id: options.threadId,
        name: `room${options.marker}`,
        owner_id: 'application-123',
        parent_id: options.parentChannelId,
        thread_metadata: { archived: false },
        type: 12,
      });
    }
    if (
      method === 'DELETE' &&
      url.pathname === `/api/v10/channels/${options.threadId}`
    ) {
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url.pathname.endsWith('/users/@me/channels')) {
      const recipientId = (body as { recipient_id: string }).recipient_id;
      return Response.json({ id: `dm-${recipientId}` });
    }
    if (
      method === 'POST' &&
      url.pathname.startsWith('/api/v10/channels/dm-') &&
      url.pathname.endsWith('/messages')
    ) {
      return Response.json({ id: 'dm-message' });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };
}

function assertPrivateThreadCreation(
  requests: RecordedRequest[],
  parentChannelId: string,
) {
  const creation = requests.find(
    ({ method, pathname }) =>
      method === 'POST' &&
      pathname === `/api/v10/channels/${parentChannelId}/threads`,
  );
  assert.ok(creation);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(creation.body as Record<string, unknown>).filter(
        ([key]) => key !== 'name',
      ),
    ),
    {
      auto_archive_duration: 10_080,
      invitable: false,
      type: 12,
    },
  );
  assert.equal(typeof (creation.body as { name?: unknown }).name, 'string');
}

function assertNoPermissionOverwriteRequests(requests: RecordedRequest[]) {
  assert.equal(
    requests.some(({ pathname }) => pathname.includes('/permissions/')),
    false,
  );
}

function createEnv(
  equipmentStates: Array<{ status: string; syncRevision: number }> = [
    { status: 'active', syncRevision: 1 },
  ],
  scheduleStates: {
    darkroom?: Array<{
      discordSyncStatus: string;
      status: string;
      syncRevision: number;
    }>;
    studio?: Array<{
      discordSyncStatus: string;
      status: string;
      syncRevision: number;
    }>;
  } = {},
): Env {
  let equipmentStateIndex = 0;
  let darkroomStateIndex = 0;
  let studioStateIndex = 0;
  const darkroomStates = scheduleStates.darkroom ?? [
    { discordSyncStatus: 'pending', status: 'open', syncRevision: 1 },
  ];
  const studioStates = scheduleStates.studio ?? [
    { discordSyncStatus: 'pending', status: 'approved', syncRevision: 1 },
  ];
  return {
    API_WORKER: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (
          url.pathname === '/api/v1/loans/equipment-loan/discord-sync-state'
        ) {
          const state =
            equipmentStates[
              Math.min(equipmentStateIndex, equipmentStates.length - 1)
            ];
          equipmentStateIndex += 1;
          return Response.json(state);
        }
        if (
          url.pathname ===
          '/api/v1/darkroom/schedule/darkroom-slot/discord-sync-state'
        ) {
          const state =
            darkroomStates[
              Math.min(darkroomStateIndex, darkroomStates.length - 1)
            ];
          darkroomStateIndex += 1;
          return Response.json(state);
        }
        if (
          url.pathname ===
          '/api/v1/studio/requests/studio-request/discord-sync-state'
        ) {
          const state =
            studioStates[Math.min(studioStateIndex, studioStates.length - 1)];
          studioStateIndex += 1;
          return Response.json(state);
        }
        throw new Error(`Unexpected API Worker request: ${url.pathname}`);
      },
    } as unknown as Fetcher,
    DISCORD_APPLICATION_ID: 'application-123',
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_TOKEN: 'discord-token',
  };
}

function studioEvent(): StudioScheduleSyncInternalEvent {
  return {
    channelId: null,
    endsAt: '2099-07-21T14:00:00.000Z',
    messageId: null,
    removeDiscordId: null,
    requestId: 'studio-request',
    requester: {
      discordId: 'studio-member',
      name: 'Studio Member',
      userId: 'studio-user',
    },
    startsAt: '2099-07-21T12:00:00.000Z',
    status: 'approved',
    syncRevision: 1,
    type: 'website.studio.schedule.sync',
  };
}

function darkroomEvent(): DarkroomScheduleSyncInternalEvent {
  return {
    capacity: 4,
    channelId: null,
    endsAt: '2099-07-21T14:00:00.000Z',
    messageId: null,
    registeredCount: 1,
    registrants: [
      {
        discordId: 'darkroom-member',
        name: 'Darkroom Member',
        registeredAt: '2099-07-20T12:00:00.000Z',
        userId: 'darkroom-user',
      },
    ],
    removeDiscordIds: ['former-member'],
    slotId: 'darkroom-slot',
    startsAt: '2099-07-21T12:00:00.000Z',
    status: 'open',
    syncRevision: 1,
    title: 'Open Darkroom',
    type: 'website.darkroom.schedule.sync',
  };
}

function equipmentEvent(): EquipmentLoanSyncInternalEvent {
  return {
    approvedAt: '2026-07-20T12:00:00.000Z',
    borrower: {
      discordId: 'borrower',
      name: 'Borrower',
      userId: 'borrower-user',
    },
    channelId: null,
    dueDate: '2099-07-30T12:00:00.000Z',
    equipment: {
      assetTag: 'CAM-1',
      category: 'camera',
      id: 'equipment',
      model: 'Model',
      name: 'Camera',
    },
    isPpcOwned: false,
    lender: {
      discordId: 'lender',
      name: 'Lender',
      userId: 'lender-user',
    },
    loanId: 'equipment-loan',
    messageId: null,
    notes: null,
    requestedAt: '2026-07-19T12:00:00.000Z',
    returnedAt: null,
    status: 'active',
    syncRevision: 1,
    termsSnapshot: null,
    type: 'website.equipment.loan.sync',
    updateChannel: false,
  };
}

function equipmentParserPayload() {
  return {
    ...equipmentEvent(),
    borrower: {
      discordId: '1517861087947657389',
      name: 'Borrower',
      userId: 'borrower-user',
    },
    channelId: '1513286980518023348',
    lender: {
      discordId: '1512900016979837161',
      name: 'Lender',
      userId: 'lender-user',
    },
    loanId: 'equipment-loan',
    messageId: '1513603798029828218',
  };
}
