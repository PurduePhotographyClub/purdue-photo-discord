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
import {
  assertManagedPrivateThread,
  findManagedPrivateThread,
} from './discordPrivateThreadService';
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
    participantIds: ['studio-member', 'studio-manager'],
    removedParticipantIds: ['former-studio-manager'],
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
  assertThreadMemberAddedOnce(requests, 'studio-thread', 'studio-manager');
  assertThreadMemberRemovedOnce(
    requests,
    'studio-thread',
    'former-studio-manager',
  );
  assertThreadMemberNotRemoved(requests, 'studio-thread', 'studio-manager');
  assertThreadMemberNotRemoved(requests, 'studio-thread', 'invited-executive');
  assertNoPermissionOverwriteRequests(requests);
});

test('darkroom rooms reconcile participant additions and removals through thread members', async () => {
  const requests: RecordedRequest[] = [];
  installThreadCreationFetchMock(requests, {
    parentChannelId: DARKROOM_REQUESTS_CHANNEL_ID,
    participantIds: ['darkroom-member', 'darkroom-manager'],
    removedParticipantIds: ['former-member', 'former-darkroom-manager'],
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
  assertThreadMemberAddedOnce(requests, 'darkroom-thread', 'darkroom-member');
  assertThreadMemberAddedOnce(requests, 'darkroom-thread', 'darkroom-manager');
  assertThreadMemberRemovedOnce(
    requests,
    'darkroom-thread',
    'former-darkroom-manager',
  );
  assertThreadMemberNotRemoved(requests, 'darkroom-thread', 'darkroom-manager');
  assertThreadMemberNotRemoved(
    requests,
    'darkroom-thread',
    'invited-executive',
  );
  const rootMessage = requests.find(
    ({ method, pathname }) =>
      method === 'POST' &&
      pathname === '/api/v10/channels/darkroom-thread/messages',
  );
  const rootComponents = JSON.stringify(
    (rootMessage?.body as { components?: unknown[] } | undefined)?.components,
  );
  assert.match(rootComponents, /darkroom_schedule_drop:darkroom-slot/);
  assert.match(rootComponents, /darkroom_schedule_end:darkroom-slot/);
  assert.match(rootComponents, /darkroom_schedule_cancel:darkroom-slot/);
  assertNoPermissionOverwriteRequests(requests);
});

test('equipment rooms use the equipment requests channel and add both parties', async () => {
  const requests: RecordedRequest[] = [];
  installThreadCreationFetchMock(requests, {
    parentChannelId: EQUIPMENT_REQUESTS_CHANNEL_ID,
    participantIds: ['borrower', 'lender', 'equipment-manager'],
    removedParticipantIds: ['former-equipment-manager'],
    threadId: 'equipment-thread',
  });

  const result = await syncEquipmentLoanChannel(createEnv(), equipmentEvent());

  assert.deepEqual(result, {
    channelId: 'equipment-thread',
    messageId: 'equipment-thread-message',
  });
  assertPrivateThreadCreation(requests, EQUIPMENT_REQUESTS_CHANNEL_ID);
  assertThreadMemberAddedOnce(requests, 'equipment-thread', 'borrower');
  assertThreadMemberAddedOnce(requests, 'equipment-thread', 'lender');
  assertThreadMemberAddedOnce(
    requests,
    'equipment-thread',
    'equipment-manager',
  );
  assertThreadMemberRemovedOnce(
    requests,
    'equipment-thread',
    'former-equipment-manager',
  );
  assertThreadMemberNotRemoved(
    requests,
    'equipment-thread',
    'equipment-manager',
  );
  assertThreadMemberNotRemoved(
    requests,
    'equipment-thread',
    'invited-executive',
  );
  assertNoPermissionOverwriteRequests(requests);
});

test('darkroom join, drop, and rejoin reuse a strongly matched thread when Discord omits owner_id', async () => {
  const requests: RecordedRequest[] = [];
  let threadName = 'darkroom--pcc-darkroom-darkroom-slot-r1';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ body, method, pathname: url.pathname });

    if (
      method === 'GET' &&
      url.pathname === '/api/v10/channels/darkroom-thread'
    ) {
      return Response.json({
        guild_id: 'guild-123',
        id: 'darkroom-thread',
        name: threadName,
        parent_id: DARKROOM_REQUESTS_CHANNEL_ID,
        thread_metadata: { archived: false },
        type: 12,
      });
    }
    if (
      method === 'PATCH' &&
      url.pathname === '/api/v10/channels/darkroom-thread'
    ) {
      threadName = (body as { name: string }).name;
      return Response.json({ id: 'darkroom-thread', name: threadName });
    }
    if (
      method === 'PUT' &&
      url.pathname.startsWith(
        '/api/v10/channels/darkroom-thread/thread-members/',
      )
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      method === 'DELETE' &&
      url.pathname.startsWith(
        '/api/v10/channels/darkroom-thread/thread-members/',
      )
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      method === 'PATCH' &&
      url.pathname ===
        '/api/v10/channels/darkroom-thread/messages/darkroom-message'
    ) {
      return Response.json({ id: 'darkroom-message' });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  const env = createEnv(undefined, {
    darkroom: [
      { discordSyncStatus: 'pending', status: 'open', syncRevision: 1 },
      { discordSyncStatus: 'pending', status: 'open', syncRevision: 2 },
      { discordSyncStatus: 'pending', status: 'open', syncRevision: 3 },
    ],
  });
  const joinedEvent: DarkroomScheduleSyncInternalEvent = {
    ...darkroomEvent(),
    channelId: 'darkroom-thread',
    managerDiscordIds: ['darkroom-manager'],
    messageId: 'darkroom-message',
    removeDiscordIds: [],
    syncRevision: 1,
  };
  const droppedEvent: DarkroomScheduleSyncInternalEvent = {
    ...darkroomEvent(),
    channelId: 'darkroom-thread',
    managerDiscordIds: ['darkroom-manager'],
    messageId: 'darkroom-message',
    registeredCount: 0,
    registrants: [],
    removeDiscordIds: ['darkroom-member'],
    syncRevision: 2,
  };
  const rejoinedEvent: DarkroomScheduleSyncInternalEvent = {
    ...darkroomEvent(),
    channelId: 'darkroom-thread',
    managerDiscordIds: ['darkroom-manager'],
    messageId: 'darkroom-message',
    removeDiscordIds: ['darkroom-member'],
    syncRevision: 3,
  };

  const joined = await syncDarkroomScheduleChannel(env, joinedEvent);
  const dropped = await syncDarkroomScheduleChannel(env, droppedEvent);
  const rejoined = await syncDarkroomScheduleChannel(env, rejoinedEvent);

  assert.deepEqual(joined, {
    channelId: 'darkroom-thread',
    messageId: 'darkroom-message',
  });
  assert.deepEqual(dropped, {
    channelId: 'darkroom-thread',
    messageId: 'darkroom-message',
  });
  assert.deepEqual(rejoined, dropped);
  assert.deepEqual(
    requests
      .filter(({ pathname }) =>
        pathname.endsWith('/thread-members/darkroom-member'),
      )
      .map(({ method }) => method),
    ['PUT', 'DELETE', 'PUT'],
  );
  assert.equal(
    requests.some(
      ({ method, pathname }) =>
        method === 'POST' && pathname.endsWith('/threads'),
    ),
    false,
  );
});

test('managed private threads still reject an explicit mismatched owner_id', () => {
  assert.throws(
    () =>
      assertManagedPrivateThread(
        createEnv(),
        {
          guild_id: 'guild-123',
          id: 'darkroom-thread',
          name: 'darkroom--pcc-darkroom-darkroom-slot-r1',
          owner_id: 'foreign-application',
          parent_id: DARKROOM_REQUESTS_CHANNEL_ID,
          type: 12,
        },
        {
          marker: '--pcc-darkroom-darkroom-slot',
          parentChannelId: DARKROOM_REQUESTS_CHANNEL_ID,
          syncRevision: 1,
        },
      ),
    /ownership mismatch/,
  );
});

test('scan-discovered managed private threads require an explicit matching owner_id', async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (
      (init?.method ?? 'GET') === 'GET' &&
      url.pathname === '/api/v10/guilds/guild-123/threads/active'
    ) {
      return Response.json({
        threads: [
          {
            guild_id: 'guild-123',
            id: 'spoofed-thread',
            name: 'darkroom--pcc-darkroom-darkroom-slot-r1',
            parent_id: DARKROOM_REQUESTS_CHANNEL_ID,
            type: 12,
          },
        ],
      });
    }
    throw new Error(`Unexpected Discord API call: ${url.pathname}`);
  };

  await assert.rejects(
    () =>
      findManagedPrivateThread(createEnv(), {
        marker: '--pcc-darkroom-darkroom-slot',
        parentChannelId: DARKROOM_REQUESTS_CHANNEL_ID,
        syncRevision: 1,
      }),
    /ownership mismatch/,
  );
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

  const parsed = parseInternalEvent({
    ...basePayload,
    managerDiscordIds: ['1517861087947657389'],
  });
  assert.equal(parsed.kind, 'equipmentLoan');
  assert.deepEqual(
    parsed.event.type === 'website.equipment.loan.sync'
      ? parsed.event.managerDiscordIds
      : undefined,
    ['1517861087947657389'],
  );
  assert.deepEqual(
    parsed.event.type === 'website.equipment.loan.sync'
      ? parsed.event.removeManagerDiscordIds
      : undefined,
    ['1513603798029828218'],
  );

  const queuedManagerRemovals = managerRemovalQueue(25);
  const queuedRemovalEvent = parseInternalEvent({
    ...basePayload,
    removeManagerDiscordIds: queuedManagerRemovals,
  });
  assert.deepEqual(
    queuedRemovalEvent.kind === 'equipmentLoan'
      ? queuedRemovalEvent.event.removeManagerDiscordIds
      : undefined,
    queuedManagerRemovals,
  );

  const dedupedRemovalEvent = parseInternalEvent({
    ...basePayload,
    removeManagerDiscordIds: [
      queuedManagerRemovals[0],
      queuedManagerRemovals[0],
    ],
  });
  assert.deepEqual(
    dedupedRemovalEvent.kind === 'equipmentLoan'
      ? dedupedRemovalEvent.event.removeManagerDiscordIds
      : undefined,
    [queuedManagerRemovals[0]],
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...basePayload,
        removeManagerDiscordIds: managerRemovalQueue(26),
      }),
    /removeManagerDiscordIds must be an array of strings/,
  );

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
    { ...basePayload, managerDiscordIds: ['not-a-snowflake'] },
    { ...basePayload, removeManagerDiscordIds: ['not-a-snowflake'] },
  ]) {
    assert.throws(
      () => parseInternalEvent(payload),
      /must be a Discord snowflake/,
    );
  }

  assert.throws(
    () =>
      parseInternalEvent({
        ...basePayload,
        managerDiscordIds: ['1517861087947657389', '1512900016979837161'],
      }),
    /Equipment loan managerDiscordIds must contain at most 1 ID/,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...basePayload,
        managerDiscordIds: ['1517861087947657389', '1517861087947657389'],
      }),
    /Equipment loan managerDiscordIds must contain unique IDs/,
  );
});

test('studio and darkroom sync parsing carries validated manager membership changes', () => {
  const darkroomManagerDiscordIds = [
    '1517861087947657389',
    '1512900016979837161',
  ];
  const studioManagerDiscordIds = ['1517861087947657389'];
  const darkroomRemoveManagerDiscordIds = ['1513286980518023348'];
  const studioRemoveManagerDiscordIds = ['1513603798029828218'];
  const darkroomPayload = {
    capacity: 4,
    endsAt: '2099-07-21T14:00:00.000Z',
    managerDiscordIds: darkroomManagerDiscordIds,
    removeManagerDiscordIds: darkroomRemoveManagerDiscordIds,
    registeredCount: 0,
    registrants: [],
    slotId: '11111111-1111-4111-8111-111111111111',
    startsAt: '2099-07-21T12:00:00.000Z',
    status: 'open',
    syncRevision: 1,
    title: 'Open Darkroom',
    type: 'website.darkroom.schedule.sync',
  };
  const studioPayload = {
    endsAt: '2099-07-21T14:00:00.000Z',
    managerDiscordIds: studioManagerDiscordIds,
    removeManagerDiscordIds: studioRemoveManagerDiscordIds,
    requester: {
      discordId: '1512900016979837161',
      name: 'Studio Member',
      userId: 'studio-user',
    },
    requestId: '22222222-2222-4222-8222-222222222222',
    startsAt: '2099-07-21T12:00:00.000Z',
    status: 'approved',
    syncRevision: 1,
    type: 'website.studio.schedule.sync',
  };

  const darkroom = parseInternalEvent(darkroomPayload);
  const studio = parseInternalEvent(studioPayload);
  if (darkroom.kind !== 'darkroomSchedule') {
    assert.fail('Expected a darkroom schedule event.');
  }
  if (studio.kind !== 'studioSchedule') {
    assert.fail('Expected a studio schedule event.');
  }
  assert.deepEqual(darkroom.event.managerDiscordIds, darkroomManagerDiscordIds);
  assert.deepEqual(studio.event.managerDiscordIds, studioManagerDiscordIds);
  assert.deepEqual(
    darkroom.event.removeManagerDiscordIds,
    darkroomRemoveManagerDiscordIds,
  );
  assert.deepEqual(
    studio.event.removeManagerDiscordIds,
    studioRemoveManagerDiscordIds,
  );

  assert.throws(
    () =>
      parseInternalEvent({
        ...darkroomPayload,
        managerDiscordIds: ['not-a-snowflake'],
      }),
    /Darkroom schedule managerDiscordIds must be a Discord snowflake/,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...studioPayload,
        managerDiscordIds: ['not-a-snowflake'],
      }),
    /Studio schedule managerDiscordIds must be a Discord snowflake/,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...darkroomPayload,
        removeManagerDiscordIds: ['not-a-snowflake'],
      }),
    /Darkroom schedule removeManagerDiscordIds must be a Discord snowflake/,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...studioPayload,
        removeManagerDiscordIds: ['not-a-snowflake'],
      }),
    /Studio schedule removeManagerDiscordIds must be a Discord snowflake/,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...darkroomPayload,
        managerDiscordIds: [
          '1517861087947657389',
          '1512900016979837161',
          '1513286980518023348',
        ],
      }),
    /Darkroom schedule managerDiscordIds must contain at most 2 IDs/,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...darkroomPayload,
        managerDiscordIds: ['1517861087947657389', '1517861087947657389'],
      }),
    /Darkroom schedule managerDiscordIds must contain unique IDs/,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...studioPayload,
        managerDiscordIds: ['1517861087947657389', '1512900016979837161'],
      }),
    /Studio schedule managerDiscordIds must contain at most 1 ID/,
  );
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

function assertThreadMemberAddedOnce(
  requests: RecordedRequest[],
  threadId: string,
  discordId: string,
) {
  assert.equal(
    requests.filter(
      ({ method, pathname }) =>
        method === 'PUT' &&
        pathname ===
          `/api/v10/channels/${threadId}/thread-members/${discordId}`,
    ).length,
    1,
  );
}

function assertThreadMemberRemovedOnce(
  requests: RecordedRequest[],
  threadId: string,
  discordId: string,
) {
  assert.equal(
    requests.filter(
      ({ method, pathname }) =>
        method === 'DELETE' &&
        pathname ===
          `/api/v10/channels/${threadId}/thread-members/${discordId}`,
    ).length,
    1,
  );
}

function assertThreadMemberNotRemoved(
  requests: RecordedRequest[],
  threadId: string,
  discordId: string,
) {
  assert.equal(
    requests.filter(
      ({ method, pathname }) =>
        method === 'DELETE' &&
        pathname ===
          `/api/v10/channels/${threadId}/thread-members/${discordId}`,
    ).length,
    0,
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
    managerDiscordIds: ['studio-manager', 'studio-member', 'studio-manager'],
    removeDiscordId: null,
    removeManagerDiscordIds: ['former-studio-manager', 'studio-manager'],
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
    managerDiscordIds: [
      'darkroom-manager',
      'darkroom-member',
      'darkroom-manager',
    ],
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
    removeManagerDiscordIds: ['former-darkroom-manager', 'darkroom-manager'],
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
    managerDiscordIds: ['equipment-manager', 'borrower', 'equipment-manager'],
    messageId: null,
    notes: null,
    requestedAt: '2026-07-19T12:00:00.000Z',
    removeManagerDiscordIds: ['former-equipment-manager', 'equipment-manager'],
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
    managerDiscordIds: ['1517861087947657389'],
    messageId: '1513603798029828218',
    removeManagerDiscordIds: ['1513603798029828218'],
  };
}

function managerRemovalQueue(size: number) {
  return Array.from(
    { length: size },
    (_, index) => `151786108794765${String(index).padStart(4, '0')}`,
  );
}
