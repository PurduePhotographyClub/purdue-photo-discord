import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCompetitionStatusContent,
  buildReadOnlyOverwrites,
  normalizeCompetitionForumName,
} from './discordCompetitionService';
import { parseInternalEvent } from '../internal-events/parser';
import { handleCompetitionGatewayEvent } from './discordCompetitionGatewayService';
import type { Env } from '../discord/types';
import type { GatewayInternalEvent } from '@pccbot/shared';

test('competition status post includes state, deadline, and the entry template', () => {
  const content = buildCompetitionStatusContent({
    description: null,
    forumChannelId: null,
    id: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
    results: [],
    status: 'open',
    statusMessageId: null,
    statusThreadId: null,
    submissionDeadline: '2026-09-30',
    syncRevision: 1,
    theme: 'Reflections',
    title: 'September Competition',
  });

  assert.match(content, /Status: Open for entries/);
  assert.match(content, /Deadline: September 30, 2026/);
  assert.match(content, /One entry per person/);
  assert.match(content, /Attach exactly one image/);
});

test('forum names are Discord-safe and bounded', () => {
  assert.equal(
    normalizeCompetitionForumName('  Night / Light!  '),
    'night-light',
  );
  assert.ok(normalizeCompetitionForumName('A'.repeat(200)).length <= 100);
});

test('archive overwrites remove every write and reaction allow', () => {
  const [overwrite] = buildReadOnlyOverwrites([
    { allow: String(64 + 2048), deny: '0', id: '123', type: 0 },
  ]);
  assert.ok(overwrite);
  assert.equal(BigInt(overwrite.allow) & 64n, 0n);
  assert.notEqual(BigInt(overwrite.deny) & 64n, 0n);
  assert.notEqual(BigInt(overwrite.deny) & 274877906944n, 0n);
});

test('competition sync parsing requires all three places before ending', () => {
  const base = {
    competition: {
      description: null,
      forumChannelId: null,
      id: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
      results: [],
      status: 'closed',
      statusMessageId: null,
      statusThreadId: null,
      submissionDeadline: '2026-09-30',
      syncRevision: 2,
      theme: null,
      title: 'September Competition',
    },
    type: 'website.competition.sync',
  };
  assert.throws(() => parseInternalEvent(base), /first, second, and third/);
});

test('competition deletion accepts only a Discord forum snowflake', () => {
  assert.deepEqual(
    parseInternalEvent({
      forumChannelId: '323456789012345678',
      type: 'website.competition.delete',
    }),
    {
      event: {
        forumChannelId: '323456789012345678',
        type: 'website.competition.delete',
      },
      kind: 'competitionDelete',
    },
  );
  assert.throws(
    () =>
      parseInternalEvent({
        forumChannelId: 'not-a-snowflake',
        type: 'website.competition.delete',
      }),
    /forumChannelId/,
  );
});

test('one valid forum starter is registered through the private API', async () => {
  const requests: Request[] = [];
  const env = {
    API_WORKER: {
      fetch: async (request: Request) => {
        requests.push(request.clone());
        return request.method === 'GET'
          ? Response.json({ found: true, status: 'open' })
          : Response.json({ id: 'entry-id' }, { status: 201 });
      },
    },
    INTERNAL_TOKEN: 'test-internal-token',
  } as unknown as Env;
  const event: GatewayInternalEvent = {
    channelId: '223456789012345678',
    eventType: 'MESSAGE_CREATE',
    guildId: '1182061172309106708',
    messageId: '223456789012345678',
    payload: {
      attachments: [
        {
          content_type: 'image/jpeg',
          filename: 'entry.jpg',
          url: 'https://cdn.discordapp.com/attachments/1/2/entry.jpg',
        },
      ],
      author: {
        global_name: 'Purdue Photographer',
        id: '123456789012345678',
      },
      category_id: '1512508504081039482',
      content: 'Reflections on campus at blue hour.',
      parent_channel_id: '323456789012345678',
      thread_name: 'Blue hour',
      timestamp: '2026-09-14T20:00:00.000Z',
    },
    receivedAt: '2026-09-14T20:00:01.000Z',
    type: 'discord.gateway.event',
    userId: '123456789012345678',
  };

  assert.deepEqual(await handleCompetitionGatewayEvent(event, env), {
    handled: true,
  });
  assert.equal(requests.length, 2);
  assert.equal(
    new URL(requests[1]!.url).pathname,
    '/api/v1/competitions/discord-entries',
  );
  assert.equal(
    requests[1]!.headers.get('x-pcc-actor-discord-id'),
    '123456789012345678',
  );
  const body = (await requests[1]!.json()) as Record<string, unknown>;
  assert.equal(body.title, 'Blue hour');
  assert.equal(body.discordDisplayName, 'Purdue Photographer');
});
