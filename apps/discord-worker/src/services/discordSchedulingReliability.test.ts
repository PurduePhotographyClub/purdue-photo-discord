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

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const readSource = async (relativePath: string) =>
  readFile(resolve(sourceDirectory, relativePath), 'utf8');

test('internal scheduling events authenticate before parsing or logging payload metadata', async () => {
  const source = await readSource('../routes/internalEvents.ts');
  const authorizeIndex = source.indexOf('await authorizeGatewayRequest');
  const parseIndex = source.indexOf('parseInternalEvent(');
  const receivedLogIndex = source.indexOf(
    "logger.info('Received internal event.'",
  );

  assert.ok(authorizeIndex > 0);
  assert.ok(authorizeIndex < parseIndex);
  assert.ok(authorizeIndex < receivedLogIndex);
  assert.match(source, /isSchedulingEvent\(parsedEvent\)/);
  assert.match(source, /retryDiscordRateLimitedOperation/);
  assert.match(source, /maxRetryDelayMs:\s*15_000/);
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

test('schedule channels are verified by guild, category, and ownership marker', async () => {
  const [darkroom, studio] = await Promise.all([
    readSource('./discordDarkroomScheduleService.ts'),
    readSource('./discordStudioScheduleService.ts'),
  ]);

  assert.match(darkroom, /assertDarkroomScheduleChannelOwnership/);
  assert.match(darkroom, /channel\.guild_id !== guildId/);
  assert.match(
    darkroom,
    /split\('\s*\|\s*'\)\.at\(-1\)\?\.startsWith\(markerPrefix\)/,
  );
  assert.match(studio, /assertStudioScheduleChannelOwnership/);
  assert.match(studio, /channel\.guild_id !== guildId/);
  assert.match(
    studio,
    /split\('\s*\|\s*'\)\.at\(-1\)\?\.startsWith\(markerPrefix\)/,
  );
  assert.doesNotMatch(darkroom, /isExplicitLegacyAdoption/);
  assert.match(darkroom, /status === 404\) return false/);
  assert.match(studio, /isDiscordNotFoundError\(error\)\) return false/);
  assert.match(darkroom, /1_024 - marker\.length - 3/);
  assert.match(studio, /1_024 - marker\.length - 3/);
  assert.match(darkroom, /storedRevision > event\.syncRevision/);
  assert.match(studio, /storedRevision > event\.syncRevision/);
  assert.match(
    darkroom,
    /existingChannel[\s\S]*assertDarkroomScheduleChannelOwnership/,
  );
  assert.match(
    studio,
    /existingChannel[\s\S]*assertStudioScheduleChannelOwnership/,
  );
});

test('darkroom interaction synchronization settles channel and weekly work independently', async () => {
  const source = await readSource('./discordDarkroomScheduleService.ts');

  assert.match(source, /syncDarkroomInteractionState/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /weeklyJoinMessageEvents/);
  assert.match(source, /weekly refresh is missing its message ID/);
});

test('darkroom permission and notification fan-out uses bounded concurrency', async () => {
  const source = await readSource('./discordDarkroomScheduleService.ts');

  assert.match(source, /DARKROOM_DISCORD_MUTATION_CONCURRENCY\s*=\s*2/);
  assert.match(source, /runWithConcurrency\(\s*changes/);
  assert.match(source, /runWithConcurrency\(\s*discordIds/);
});

test('stale weekly messages are reported and existing schedule markers advance', async () => {
  const [dispatcher, darkroom, studio] = await Promise.all([
    readSource('../internal-events/dispatcher.ts'),
    readSource('./discordDarkroomScheduleService.ts'),
    readSource('./discordStudioScheduleService.ts'),
  ]);

  assert.match(darkroom, /stale:\s*result === null/);
  assert.match(dispatcher, /ok:\s*result\.ok/);
  assert.match(studio, /if \(!didCreateChannel\)/);
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
