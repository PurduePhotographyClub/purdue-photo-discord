import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Env } from '../discord/types';
import { sweepExpiredPhotographerRequests } from './photographerRequestStatusService';

const INDIVIDUAL_CHANNEL_ID = '1512507940303671546';
const ORGANIZATION_CHANNEL_ID = '1512508172139499670';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('sweepExpiredPhotographerRequests marks past-dated open requests expired', async () => {
  let patchBody: Record<string, unknown> | null = null;
  const requestedPaths: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    const method = init?.method ?? 'GET';
    requestedPaths.push(`${method} ${path}`);

    if (
      method === 'GET' &&
      path === `/api/v10/channels/${INDIVIDUAL_CHANNEL_ID}/messages?limit=100`
    ) {
      return Response.json([
        {
          embeds: [
            buildPhotographerRequestEmbed({
              date: '2026-07-06',
              endTime: '17:30',
              status: 'OPEN',
            }),
          ],
          id: 'expired-message',
        },
      ]);
    }

    if (
      method === 'GET' &&
      path === `/api/v10/channels/${ORGANIZATION_CHANNEL_ID}/messages?limit=100`
    ) {
      return Response.json([]);
    }

    if (
      method === 'PATCH' &&
      path ===
        `/api/v10/channels/${INDIVIDUAL_CHANNEL_ID}/messages/expired-message`
    ) {
      patchBody = JSON.parse(String(init?.body));
      return Response.json({ id: 'expired-message' });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${path}`);
  };

  const result = await sweepExpiredPhotographerRequests(createEnv(), {
    maxPagesPerChannel: 1,
    now: new Date('2026-07-07T18:00:00.000Z'),
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.expired, 1);
  assert.equal(result.failed, 0);
  assert.ok(
    requestedPaths.includes(
      `PATCH /api/v10/channels/${INDIVIDUAL_CHANNEL_ID}/messages/expired-message`,
    ),
  );

  const patch = patchBody as {
    embeds?: Array<{
      color?: number;
      fields?: Array<{ inline?: boolean; name: string; value: string }>;
    }>;
  } | null;
  assert.ok(patch);
  const embeds = patch.embeds ?? [];
  assert.ok(embeds.length > 0);
  const expiredEmbed = embeds[0];
  assert.equal(expiredEmbed?.color, 0x8b949e);
  assert.deepEqual(expiredEmbed?.fields?.slice(0, 2), [
    {
      inline: true,
      name: 'Status',
      value: 'EXPIRED',
    },
    {
      name: 'Expired',
      value: 'This job has expired, but you can still contact the owner.',
    },
  ]);
});

test('sweepExpiredPhotographerRequests leaves future and final-status requests unchanged', async () => {
  let patchCount = 0;

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    const method = init?.method ?? 'GET';

    if (
      method === 'GET' &&
      path === `/api/v10/channels/${INDIVIDUAL_CHANNEL_ID}/messages?limit=100`
    ) {
      return Response.json([
        {
          embeds: [
            buildPhotographerRequestEmbed({
              date: '2026-07-08',
              endTime: '09:00',
              status: 'OPEN',
            }),
          ],
          id: 'future-message',
        },
        {
          embeds: [
            buildPhotographerRequestEmbed({
              date: '2026-07-06',
              endTime: '17:30',
              status: 'ACCEPTED',
            }),
          ],
          id: 'accepted-message',
        },
      ]);
    }

    if (
      method === 'GET' &&
      path === `/api/v10/channels/${ORGANIZATION_CHANNEL_ID}/messages?limit=100`
    ) {
      return Response.json([]);
    }

    if (method === 'PATCH') {
      patchCount += 1;
      return Response.json({ id: 'unexpected-patch' });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${path}`);
  };

  const result = await sweepExpiredPhotographerRequests(createEnv(), {
    maxPagesPerChannel: 1,
    now: new Date('2026-07-07T18:00:00.000Z'),
  });

  assert.equal(result.scanned, 2);
  assert.equal(result.expired, 0);
  assert.equal(result.skipped, 2);
  assert.equal(patchCount, 0);
});

function createEnv(): Env {
  return {
    DISCORD_TOKEN: 'test-discord-token',
  };
}

function buildPhotographerRequestEmbed(input: {
  date: string;
  endTime: string;
  status: string;
}) {
  return {
    color: 0x58a6ff,
    fields: [
      {
        inline: true,
        name: 'Request ID',
        value: 'REQ12345',
      },
      {
        inline: true,
        name: 'Status',
        value: input.status,
      },
      {
        inline: true,
        name: 'Date',
        value: input.date,
      },
      {
        inline: true,
        name: 'End Time',
        value: input.endTime,
      },
      {
        name: 'Contact Information',
        value: 'owner@example.com',
      },
    ],
    footer: {
      text: 'PPC photographer request',
    },
    title: 'Photographer Request: Event Coverage',
  };
}
