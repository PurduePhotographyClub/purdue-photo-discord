import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { GatewayInternalEvent } from '@pccbot/shared';
import type { Env } from '../discord/types';
import { handleCompetitionGatewayEvent } from './discordCompetitionGatewayService';

const oldThreadId = '623456789012345678';
const newThreadId = '723456789012345678';
const forumChannelId = '323456789012345678';
const discordUserId = '823456789012345678';
const event: GatewayInternalEvent = {
  channelId: newThreadId,
  eventType: 'MESSAGE_CREATE',
  guildId: '1182061172309106708',
  messageId: newThreadId,
  payload: {
    attachments: [
      {
        content_type: 'image/jpeg',
        filename: 'new.jpg',
        url: 'https://cdn.discordapp.com/new.jpg',
      },
    ],
    author: { id: discordUserId },
    category_id: '1512508504081039482',
    content: 'A new photo description.',
    parent_channel_id: forumChannelId,
    thread_name: 'New photo',
    timestamp: '2026-09-16T12:00:00.000Z',
  },
  receivedAt: '2026-09-16T12:00:01.000Z',
  type: 'discord.gateway.event',
  userId: discordUserId,
};

function setup(
  t: TestContext,
  options: {
    deleted?: boolean;
    existingThreadId?: string;
    discordStatus?: number;
    cleanupStatus?: number;
    policy?: Record<string, unknown>;
    postStatus?: number;
    disableDms?: boolean;
  } = {},
) {
  const requests: Request[] = [];
  const discordRequests: Request[] = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    discordRequests.push(request.clone());
    if (request.method === 'GET') {
      return Response.json(
        { id: oldThreadId },
        { status: options.discordStatus ?? 404 },
      );
    }
    if (options.disableDms && request.url.endsWith('/users/@me/channels')) {
      return Response.json({}, { status: 403 });
    }
    return request.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : Response.json({ id: '923456789012345678' });
  };
  const existingThreadId = options.existingThreadId ?? oldThreadId;
  const env = {
    API_WORKER: {
      async fetch(request: Request) {
        requests.push(request.clone());
        if (request.method === 'GET') {
          return Response.json({
            existingEntry: {
              threadId: existingThreadId,
              messageId: existingThreadId,
            },
            found: true,
            status: 'open',
            ...options.policy,
          });
        }
        if (request.method === 'DELETE') {
          return Response.json(
            { deleted: options.deleted ?? true },
            { status: options.cleanupStatus ?? 200 },
          );
        }
        return Response.json(
          { id: 'new-entry' },
          { status: options.postStatus ?? 201 },
        );
      },
    },
    DISCORD_TOKEN: 'test-token',
    INTERNAL_TOKEN: 'test-internal-token',
  } as unknown as Env;
  return { env, requests, discordRequests };
}

test('resubmission clears a confirmed missing starter before registering its replacement', async (t) => {
  const { env, requests, discordRequests } = setup(t);
  assert.deepEqual(await handleCompetitionGatewayEvent(event, env), {
    handled: true,
  });
  assert.equal(
    new URL(requests[0]!.url).searchParams.get('discordUserId'),
    discordUserId,
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET', 'DELETE', 'POST'],
  );
  assert.deepEqual(await requests[1]!.json(), {
    forumChannelId,
    threadId: oldThreadId,
    messageId: oldThreadId,
  });
  assert.equal(
    ((await requests[2]!.json()) as { threadId: string }).threadId,
    newThreadId,
  );
  assert.equal(discordRequests.length, 1);
  assert.equal(discordRequests[0]!.method, 'GET');
  assert.ok(
    discordRequests[0]!.url.endsWith(
      `/channels/${oldThreadId}/messages/${oldThreadId}`,
    ),
  );
});

test('an existing live post still blocks a second competition entry', async (t) => {
  const { env, requests, discordRequests } = setup(t, { discordStatus: 200 });
  await handleCompetitionGatewayEvent(event, env);
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET'],
  );
  assert.ok(
    discordRequests.some(
      (request) =>
        request.method === 'DELETE' &&
        request.url.endsWith(`/channels/${newThreadId}`),
    ),
  );
  assert.equal(
    discordRequests.some(
      (request) =>
        request.method === 'DELETE' && request.url.includes(oldThreadId),
    ),
    false,
  );
});

test('replayed events for an accepted starter preserve that entry', async (t) => {
  const { env, requests, discordRequests } = setup(t, {
    existingThreadId: newThreadId,
  });
  await handleCompetitionGatewayEvent(event, env);
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET'],
  );
  assert.equal(discordRequests.length, 0);
});

for (const discordStatus of [403, 429, 500]) {
  test(`Discord ${discordStatus} cannot be mistaken for a deleted post`, async (t) => {
    const { env, requests, discordRequests } = setup(t, { discordStatus });
    await assert.rejects(handleCompetitionGatewayEvent(event, env));
    assert.deepEqual(
      requests.map((request) => request.method),
      ['GET'],
    );
    assert.equal(
      discordRequests.every((request) => request.method === 'GET'),
      true,
    );
  });
}

test('a failed cleanup keeps the replacement post and surfaces the error', async (t) => {
  const { env, requests, discordRequests } = setup(t, { cleanupStatus: 500 });
  await assert.rejects(handleCompetitionGatewayEvent(event, env));
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET', 'DELETE'],
  );
  assert.equal(
    discordRequests.every((request) => request.method === 'GET'),
    true,
  );
});

test('a cleanup blocked by a competition state change cannot submit a replacement', async (t) => {
  const { env, requests } = setup(t, { deleted: false });
  await handleCompetitionGatewayEvent(event, env);
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET', 'DELETE'],
  );
});

test('a new entrant submits without a Discord lookup or stale-entry cleanup', async (t) => {
  const { env, requests, discordRequests } = setup(t, {
    policy: { existingEntry: null },
  });
  await handleCompetitionGatewayEvent(event, env);
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET', 'POST'],
  );
  assert.equal(discordRequests.length, 0);
});

test('the API can still reject a replacement when the deadline passes', async (t) => {
  const { env, requests, discordRequests } = setup(t, { postStatus: 409 });
  await handleCompetitionGatewayEvent(event, env);
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET', 'DELETE', 'POST'],
  );
  assert.ok(
    discordRequests.some(
      (request) =>
        request.method === 'DELETE' &&
        request.url.endsWith(`/channels/${newThreadId}`),
    ),
  );
});

test('a duplicate post is removed even when the member has DMs disabled', async (t) => {
  const { env, discordRequests } = setup(t, {
    discordStatus: 200,
    disableDms: true,
  });
  await handleCompetitionGatewayEvent(event, env);
  assert.ok(
    discordRequests.some(
      (request) =>
        request.method === 'DELETE' &&
        request.url.endsWith(`/channels/${newThreadId}`),
    ),
  );
});

test('unsupported surfaces and non-starter messages do not attempt entry cleanup', async (t) => {
  const { env, requests, discordRequests } = setup(t);
  for (const input of [
    { ...event, payload: {} },
    {
      ...event,
      payload: { ...event.payload, category_id: '923456789012345678' },
    },
    { ...event, eventType: 'MESSAGE_UPDATE' as const },
    { ...event, messageId: oldThreadId },
    { ...event, userId: '' },
  ]) {
    await handleCompetitionGatewayEvent(input, env);
  }
  assert.equal(
    requests.every((request) => request.method === 'GET'),
    true,
  );
  assert.equal(discordRequests.length, 0);
});

test('a forum without a competition remains outside the entry workflow', async (t) => {
  const { env, requests } = setup(t, { policy: { found: false } });
  assert.deepEqual(await handleCompetitionGatewayEvent(event, env), {
    handled: false,
  });
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET'],
  );
});

test('invalid replacement posts are rejected before any old entry is touched', async (t) => {
  const { env, requests, discordRequests } = setup(t);
  for (const payload of [
    { ...event.payload, content: 'first line\nsecond line' },
    { ...event.payload, thread_name: '' },
    {
      ...event.payload,
      attachments: [
        null,
        {
          filename: 'document.pdf',
          url: 'https://cdn.discordapp.com/file.pdf',
        },
      ],
    },
  ]) {
    await handleCompetitionGatewayEvent({ ...event, payload }, env);
  }
  assert.equal(
    requests.every((request) => request.method === 'GET'),
    true,
  );
  assert.equal(
    discordRequests.some((request) => request.url.includes(oldThreadId)),
    false,
  );
});
