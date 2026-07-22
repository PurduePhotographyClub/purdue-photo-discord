import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  discordApiRequest,
  retryDiscordRateLimitedOperation,
} from '../discord/api';
import type { Env } from '../discord/types';
import { handleInternalEventsRoute } from '../routes/internalEvents';
import { postDarkroomWeeklyJoinMessage } from './discordDarkroomScheduleService';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const readSource = async (relativePath: string) =>
  readFile(resolve(sourceDirectory, relativePath), 'utf8');

test('internal scheduling events authenticate before parsing or logging payload metadata', async () => {
  const source = await readSource('../routes/internalEvents.ts');
  const boundedReadIndex = source.indexOf('await readRequestText');
  const authorizeIndex = source.indexOf('await authorizeGatewayRequest');
  const parseIndex = source.indexOf('parseJsonText(rawBody)');
  const receivedLogIndex = source.indexOf(
    "logger.info('Received internal event.'",
  );

  assert.ok(boundedReadIndex > 0);
  assert.ok(authorizeIndex > 0);
  assert.ok(boundedReadIndex < authorizeIndex);
  assert.ok(authorizeIndex < parseIndex);
  assert.ok(authorizeIndex < receivedLogIndex);
  assert.match(source, /authorizeGatewayRequest\(request, env, rawBody\)/);
  assert.doesNotMatch(source, /request\.clone\(\)/);
  assert.match(source, /isSchedulingEvent\(parsedEvent\)/);
  assert.match(source, /retryDiscordRateLimitedOperation/);
  assert.match(source, /maxRetryDelayMs:\s*15_000/);
});

test('internal event ingress rejects an unknown-length stream above 64 KiB before authorization', async () => {
  const chunkSize = 16 * 1_024;
  let chunksProduced = 0;
  let wasCancelled = false;
  const requestBody = new ReadableStream<Uint8Array>({
    cancel() {
      wasCancelled = true;
    },
    pull(controller) {
      chunksProduced += 1;
      controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
      if (chunksProduced === 8) {
        controller.close();
      }
    },
  });
  const request = new Request('https://discord.internal/internal/events', {
    body: requestBody,
    duplex: 'half',
    method: 'POST',
  } as RequestInit & { duplex: 'half' });

  assert.equal(request.headers.get('content-length'), null);

  const response = await handleInternalEventsRoute(request, {
    ENVIRONMENT: 'local',
    WORKER_SECRET: 'test-worker-secret',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'BAD_REQUEST',
      message: 'Request body is too large.',
    },
    success: false,
  });
  assert.equal(wasCancelled, true);
  assert.ok(
    chunksProduced < 8,
    'the route should stop consuming after the limit',
  );
});

test('internal event ingress authenticates the exact bounded body before parsing it', async () => {
  const request = await createSignedInternalEventRequest('{not-json');
  const response = await handleInternalEventsRoute(request, {
    ENVIRONMENT: 'local',
    WORKER_SECRET: 'test-worker-secret',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'BAD_REQUEST',
      message: 'Request body must be valid JSON.',
    },
    success: false,
  });
});

test('internal event ingress still rejects a bad signature before parsing', async () => {
  const request = await createSignedInternalEventRequest('{not-json');
  request.headers.set('x-pccbot-signature', `sha256=${'0'.repeat(64)}`);

  const response = await handleInternalEventsRoute(request, {
    ENVIRONMENT: 'local',
    WORKER_SECRET: 'test-worker-secret',
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'UNAUTHORIZED',
      message: 'Gateway request signature did not match.',
    },
    success: false,
  });
});

test('club scheduled events retry a recoverable Discord 429', async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    Response.json(
      { message: 'You are being rate limited.', retry_after: 0.501 },
      { status: 429 },
    ),
    Response.json({ id: '123456789012345678' }),
  ];
  let requestCount = 0;

  globalThis.fetch = async () => {
    const response = responses[requestCount];
    requestCount += 1;
    assert.ok(response, 'Discord received more than one retry');
    return response;
  };

  try {
    const body = JSON.stringify({
      startsAt: '2026-07-14T10:00:00.000Z',
      title: 'Club photo walk',
      type: 'website.event.create',
    });
    const request = await createSignedInternalEventRequest(body);
    const response = await handleInternalEventsRoute(request, {
      DISCORD_GUILD_ID: '234567890123456789',
      DISCORD_TOKEN: 'test-token',
      ENVIRONMENT: 'local',
      WORKER_SECRET: 'test-worker-secret',
    });

    assert.equal(response.status, 200);
    assert.equal(requestCount, 2);
    assert.deepEqual(await response.json(), {
      discordEventId: '123456789012345678',
      ok: true,
      type: 'website.event.create',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('schedule event revisions cross the parser boundary', async () => {
  const [parser, types] = await Promise.all([
    readSource('../internal-events/parser.ts'),
    readSource('../internal-events/types.ts'),
  ]);

  assert.match(parser, /syncRevision must be a non-negative integer/);
  assert.match(types, /syncRevision:\s*number/);
});

test('schedule root messages use deterministic Discord nonces', async () => {
  const [darkroom, studio] = await Promise.all([
    readSource('./discordDarkroomScheduleService.ts'),
    readSource('./discordStudioScheduleService.ts'),
  ]);

  assert.match(darkroom, /nonce:\s*buildDarkroomScheduleMessageNonce/);
  assert.match(darkroom, /nonce:\s*buildDarkroomWeeklyMessageNonce/);
  assert.match(studio, /nonce:\s*buildStudioScheduleMessageNonce/);
  assert.match(studio, /nonce:\s*buildStudioReviewMessageNonce/);
});

test('schedule threads verify strong ownership guards and reject explicit foreign owners', async () => {
  const [darkroom, equipment, privateThreads, studio] = await Promise.all([
    readSource('./discordDarkroomScheduleService.ts'),
    readSource('./discordEquipmentLoanService.ts'),
    readSource('./discordPrivateThreadService.ts'),
    readSource('./discordStudioScheduleService.ts'),
  ]);

  assert.match(privateThreads, /channel\.guild_id !== guildId/);
  assert.match(privateThreads, /channel\.owner_id === applicationId/);
  assert.match(privateThreads, /options\.allowMissingOwner === true/);
  assert.match(privateThreads, /channel\.owner_id === undefined/);
  assert.match(privateThreads, /!ownerMatches/);
  assert.match(privateThreads, /channel\.parent_id !== spec\.parentChannelId/);
  assert.match(privateThreads, /channel\.type !== DISCORD_PRIVATE_THREAD_TYPE/);
  assert.match(privateThreads, /storedRevision > spec\.syncRevision/);
  assert.match(privateThreads, /invitable:\s*false/);
  assert.match(privateThreads, /type:\s*DISCORD_PRIVATE_THREAD_TYPE/);
  assert.match(darkroom, /assertLegacyDarkroomScheduleChannelOwnership/);
  assert.match(studio, /assertLegacyStudioScheduleChannelOwnership/);
  assert.match(darkroom, /marker:\s*`--pcc-darkroom-\$\{event\.slotId\}`/);
  assert.match(equipment, /marker:\s*`--pcc-equipment-\$\{event\.loanId\}`/);
  assert.match(equipment, /syncRevision:\s*event\.syncRevision/);
  assert.match(studio, /marker:\s*`--pcc-studio-\$\{event\.requestId\}`/);
  assert.match(
    darkroom,
    /parentChannelId:\s*DARKROOM_SCHEDULE_JOIN_CHANNEL_ID/,
  );
  assert.match(studio, /parentChannelId:\s*STUDIO_SCHEDULE_CHANNEL_ID/);
});

test('darkroom interaction synchronization settles channel and weekly work independently', async () => {
  const source = await readSource('./discordDarkroomScheduleService.ts');

  assert.match(source, /syncDarkroomInteractionState/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /weeklyJoinMessageEvents/);
  assert.match(source, /weekly refresh is missing its message ID/);
  assert.match(source, /deleted:\s*event\.deleteChannel === true/);
  assert.match(source, /retryDiscordRateLimitedOperation/);
  assert.match(source, /maxRetryDelayMs:\s*15_000/);
});

test('darkroom membership and notification fan-out uses bounded concurrency', async () => {
  const source = await readSource('./discordDarkroomScheduleService.ts');

  assert.match(source, /DARKROOM_DISCORD_MUTATION_CONCURRENCY\s*=\s*2/);
  assert.match(source, /runWithConcurrency\(\s*changes/);
  assert.match(source, /runWithConcurrency\(\s*discordIds/);
});

test('stale weekly messages are reported and existing schedule markers advance', async () => {
  const [dispatcher, darkroom, privateThreads, studio] = await Promise.all([
    readSource('../internal-events/dispatcher.ts'),
    readSource('./discordDarkroomScheduleService.ts'),
    readSource('./discordPrivateThreadService.ts'),
    readSource('./discordStudioScheduleService.ts'),
  ]);

  assert.match(darkroom, /stale:\s*result === null/);
  assert.match(dispatcher, /ok:\s*result\.ok/);
  assert.match(studio, /prepareManagedPrivateThread/);
  assert.match(privateThreads, /storedRevision > spec\.syncRevision/);
});

test('automatic weekly refreshes never create a replacement after a Discord 404', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method ?? 'GET');
    return Response.json({ message: 'Unknown Message' }, { status: 404 });
  };

  try {
    const result = await postDarkroomWeeklyJoinMessage(
      { DISCORD_TOKEN: 'test-token' },
      weeklyJoinEvent(),
      { allowCreate: false },
    );
    assert.deepEqual(result, {
      channelId: '1512900016979837161',
      messageId: null,
      ok: false,
      stale: true,
    });
    assert.deepEqual(methods, ['PATCH']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('explicit weekly posting may replace a missing tracked message exactly once', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? 'GET';
    methods.push(method);
    return method === 'PATCH'
      ? Response.json({ message: 'Unknown Message' }, { status: 404 })
      : Response.json({ id: '888888888888888888' });
  };

  try {
    const result = await postDarkroomWeeklyJoinMessage(
      { DISCORD_TOKEN: 'test-token' },
      weeklyJoinEvent(),
      { allowCreate: true },
    );
    assert.equal(result.ok, true);
    assert.equal(result.messageId, '888888888888888888');
    assert.deepEqual(methods, ['PATCH', 'POST']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord retry-after values are treated as seconds without a millisecond heuristic', async () => {
  const source = await readSource('../discord/api.ts');

  assert.doesNotMatch(source, /retryAfter > 50/);
  assert.match(source, /retryAfter \* 1_000/);
});

test('generic Discord callers do not wait through a scheduling-sized rate limit', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return Response.json(
      { message: 'You are being rate limited.', retry_after: 0.75 },
      { status: 429 },
    );
  };

  try {
    await assert.rejects(
      discordApiRequest(
        { DISCORD_TOKEN: 'test-token' } as Env,
        '/channels/123456789012345678',
      ),
      { name: 'DiscordApiError' },
    );
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('darkroom cancellation retries a recoverable Discord 429 from the response body', async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    Response.json(
      { message: 'You are being rate limited.', retry_after: 0.75 },
      { status: 429 },
    ),
    Response.json({ id: 'cancelled-channel' }),
  ];
  let requestCount = 0;

  globalThis.fetch = async () => {
    const response = responses[requestCount];
    requestCount += 1;
    assert.ok(response, 'Discord received more than one retry');
    return response;
  };

  try {
    const result = await retryDiscordRateLimitedOperation(
      () =>
        discordApiRequest<{ id: string }>(
          { DISCORD_TOKEN: 'test-token' } as Env,
          '/channels/123456789012345678',
          {
            body: JSON.stringify({ parent_id: '234567890123456789' }),
            method: 'PATCH',
          },
        ),
      { maxRetryDelayMs: 15_000 },
    );

    assert.equal(requestCount, 2);
    assert.deepEqual(result, { id: 'cancelled-channel' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('darkroom resync retries a recoverable Discord 429 from the Retry-After header', async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    new Response(JSON.stringify({ message: 'You are being rate limited.' }), {
      headers: { 'retry-after': '0.75' },
      status: 429,
    }),
    Response.json({ id: 'resynced-message' }),
  ];
  let requestCount = 0;

  globalThis.fetch = async () => {
    const response = responses[requestCount];
    requestCount += 1;
    assert.ok(response, 'Discord received more than one retry');
    return response;
  };

  try {
    const result = await retryDiscordRateLimitedOperation(
      () =>
        discordApiRequest<{ id: string }>(
          { DISCORD_TOKEN: 'test-token' } as Env,
          '/channels/123456789012345678/messages/345678901234567890',
          {
            body: JSON.stringify({ content: 'Updated darkroom schedule' }),
            method: 'PATCH',
          },
        ),
      { maxRetryDelayMs: 15_000 },
    );

    assert.equal(requestCount, 2);
    assert.deepEqual(result, { id: 'resynced-message' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function weeklyJoinEvent() {
  return {
    allowCreate: false,
    channelId: '1512900016979837161',
    messageId: '777777777777777777',
    projectionHash: 'a'.repeat(64),
    projectionRevision: 0,
    slots: [
      {
        availableCapacity: 3,
        capacity: 4,
        endsAt: '2099-07-21T14:00:00.000Z',
        registeredCount: 1,
        slotId: '11111111-1111-4111-8111-111111111111',
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

async function createSignedInternalEventRequest(body: string) {
  const method = 'POST';
  const nonce = crypto.randomUUID();
  const path = '/internal/events';
  const secret = 'test-worker-secret';
  const timestamp = String(Date.now());
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode([method, path, timestamp, nonce, body].join('\n')),
  );
  const signatureHex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return new Request(`https://discord.internal${path}`, {
    body,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'x-pccbot-nonce': nonce,
      'x-pccbot-signature': `sha256=${signatureHex}`,
      'x-pccbot-timestamp': timestamp,
    },
    method,
  });
}
