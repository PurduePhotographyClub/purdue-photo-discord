import assert from 'node:assert/strict';
import test from 'node:test';
import type { Env } from '../discord/types';
import { parseInternalEvent } from '../internal-events/parser';
import {
  createDiscordScheduledEvent,
  updateDiscordScheduledEvent,
} from './discordScheduledEventService';

const TEST_ENV = {
  DISCORD_GUILD_ID: '123456789012345678',
  DISCORD_TOKEN: 'test-token',
} as Env;

const EVENT_INPUT = {
  description: 'Bring a camera.',
  endsAt: '2026-07-14T12:00:00.000Z',
  location: 'Purdue Memorial Union',
  startsAt: '2026-07-14T10:00:00.000Z',
  title: 'Club photo walk',
};

test('create requires Discord to return a scheduled-event snowflake', async () => {
  await withMockedFetch(
    async () => Response.json({}),
    async () => {
      await assert.rejects(
        createDiscordScheduledEvent(TEST_ENV, EVENT_INPUT),
        /Discord scheduled event response requires a valid ID/,
      );
    },
  );

  await withMockedFetch(
    async () => Response.json({ id: 'not-a-snowflake' }),
    async () => {
      await assert.rejects(
        createDiscordScheduledEvent(TEST_ENV, EVENT_INPUT),
        /Discord scheduled event response requires a valid ID/,
      );
    },
  );
});

test('update requires Discord to return a scheduled-event snowflake', async () => {
  await withMockedFetch(
    async () => Response.json({}),
    async () => {
      await assert.rejects(
        updateDiscordScheduledEvent(TEST_ENV, {
          ...EVENT_INPUT,
          discordEventId: '234567890123456789',
        }),
        /Discord scheduled event response requires a valid ID/,
      );
    },
  );
});

test('update recreates a scheduled event when its Discord ID no longer exists', async () => {
  const requests: Array<{ body: unknown; method: string; url: string }> = [];
  const responses = [
    Response.json(
      { message: 'Unknown Guild Scheduled Event' },
      { status: 404 },
    ),
    Response.json({ id: '345678901234567890' }),
  ];

  await withMockedFetch(
    async (input, init) => {
      const response = responses[requests.length];
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: init?.method ?? 'GET',
        url: String(input),
      });
      assert.ok(response, 'Discord received an unexpected request');
      return response;
    },
    async () => {
      const result = await updateDiscordScheduledEvent(TEST_ENV, {
        ...EVENT_INPUT,
        discordEventId: '234567890123456789',
      });

      assert.deepEqual(result, { id: '345678901234567890' });
    },
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.method, 'PATCH');
  assert.match(
    requests[0]?.url ?? '',
    /\/scheduled-events\/234567890123456789$/,
  );
  assert.equal(requests[1]?.method, 'POST');
  assert.match(requests[1]?.url ?? '', /\/scheduled-events$/);
  assert.deepEqual(requests[1]?.body, requests[0]?.body);
});

test('update sends description null so Discord clears the description', async () => {
  let requestBody: unknown;

  await withMockedFetch(
    async (_input, init) => {
      requestBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Response.json({ id: '234567890123456789' });
    },
    async () => {
      await updateDiscordScheduledEvent(TEST_ENV, {
        ...EVENT_INPUT,
        description: null,
        discordEventId: '234567890123456789',
      });
    },
  );

  assert.equal(
    (requestBody as Record<string, unknown> | undefined)?.description,
    null,
  );
});

test('scheduled-event parser rejects malformed Discord IDs', () => {
  for (const type of [
    'website.event.create',
    'website.event.delete',
    'website.event.update',
  ] as const) {
    assert.throws(
      () =>
        parseInternalEvent({
          discordEventId: '../not-a-snowflake',
          startsAt: '2026-07-14T10:00:00.000Z',
          title: 'Club photo walk',
          type,
        }),
      /Discord scheduled event ID must be a Discord snowflake/,
    );
  }
});

test('scheduled-event parser accepts a valid Discord ID', () => {
  assert.deepEqual(
    parseInternalEvent({
      discordEventId: '234567890123456789',
      startsAt: '2026-07-14T10:00:00.000Z',
      title: 'Club photo walk',
      type: 'website.event.update',
    }),
    {
      event: {
        discordEventId: '234567890123456789',
        startsAt: '2026-07-14T10:00:00.000Z',
        title: 'Club photo walk',
        type: 'website.event.update',
      },
      kind: 'scheduledEvent',
    },
  );
});

async function withMockedFetch(
  fetcher: typeof globalThis.fetch,
  operation: () => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;

  try {
    await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
