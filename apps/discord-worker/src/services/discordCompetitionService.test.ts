import assert from 'node:assert/strict';
import test from 'node:test';
import {
  archiveDiscordCompetition,
  buildActiveCompetitionForumOverwrites,
  buildCompetitionStatusMessage,
  buildReadOnlyOverwrites,
  buildVoteTallyOverwrites,
  COMPETITION_VOTE_EMOJI,
  createCompetitionWinnerMarker,
  normalizeCompetitionForumName,
  rankCompetitionEntriesByVotes,
  readPersistedCompetitionResults,
  syncDiscordCompetition,
} from './discordCompetitionService';
import { parseInternalEvent } from '../internal-events/parser';
import { handleCompetitionGatewayEvent } from './discordCompetitionGatewayService';
import type { Env } from '../discord/types';
import type { GatewayInternalEvent } from '@pccbot/shared';
import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';

test('competition status post uses a structured entry announcement', () => {
  const message = buildCompetitionStatusMessage(
    {
      description: null,
      entries: [],
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
    },
    '1182061172309106708',
  );

  assert.equal(message.content, '');
  assert.equal(message.embeds.length, 1);
  assert.equal(message.embeds[0]?.title, '📷 September Competition');
  assert.deepEqual(
    message.embeds[0]?.fields?.map((field) => field.name),
    ['Status', 'Entry deadline', 'Theme', 'How to enter'],
  );
  assert.match(message.embeds[0]?.description ?? '', /Entries are open/);
  assert.match(
    message.embeds[0]?.fields?.at(-1)?.value ?? '',
    /One entry per person/,
  );
  assert.match(
    message.embeds[0]?.fields?.at(-1)?.value ?? '',
    /Attach exactly one image/,
  );
});

test('voting announcement makes the heart reaction the primary instruction', () => {
  const message = buildCompetitionStatusMessage(
    {
      description: 'Photos made after sunset.',
      entries: [],
      forumChannelId: '323456789012345678',
      id: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
      results: [],
      status: 'judging',
      statusMessageId: '523456789012345678',
      statusThreadId: '623456789012345678',
      submissionDeadline: '2026-09-30',
      syncRevision: 2,
      theme: 'After dark',
      title: 'September Competition',
    },
    '1182061172309106708',
  );

  assert.match(message.embeds[0]?.description ?? '', /Voting is open/);
  assert.equal(message.embeds[0]?.fields?.at(-1)?.name, 'How to vote');
  assert.match(
    message.embeds[0]?.fields?.at(-1)?.value ?? '',
    new RegExp(COMPETITION_VOTE_EMOJI),
  );
});

test('automatic results publish zero to three entries by member vote count', () => {
  const entry = (suffix: string, title: string) => ({
    description: '',
    discordUserId: `8${suffix}`,
    messageId: `4${suffix}`,
    threadId: `4${suffix}`,
    title,
  });
  const suffixes = [
    '23456789012345678',
    '33456789012345678',
    '43456789012345678',
    '53456789012345678',
  ];

  assert.deepEqual(rankCompetitionEntriesByVotes([]), []);
  const ranked = rankCompetitionEntriesByVotes([
    { entry: entry(suffixes[0]!, 'First submitted'), index: 0, votes: 4 },
    { entry: entry(suffixes[1]!, 'Highest votes'), index: 1, votes: 7 },
    { entry: entry(suffixes[2]!, 'No votes'), index: 2, votes: 0 },
    { entry: entry(suffixes[3]!, 'Tied later'), index: 3, votes: 4 },
  ]);

  assert.deepEqual(
    ranked.map((result) => [result.place, result.title]),
    [
      [1, 'Highest votes'],
      [2, 'First submitted'],
      [3, 'Tied later'],
    ],
  );
});

test('persisted automatic winners survive a retry and reject tampering', async () => {
  const entries = [
    {
      description: 'A reflected skyline.',
      discordUserId: '823456789012345678',
      messageId: '423456789012345678',
      threadId: '423456789012345678',
      title: 'City Reflection',
    },
  ];
  const marker = await createCompetitionWinnerMarker(
    'pcc-competition:8de260c4-9e0b-4a58-a611-a19ff202c86e',
    2,
    [
      {
        ...entries[0]!,
        place: 1,
      },
    ],
    'test-worker-secret',
  );

  assert.deepEqual(
    await readPersistedCompetitionResults(
      marker,
      entries,
      '8de260c4-9e0b-4a58-a611-a19ff202c86e',
      2,
      'test-worker-secret',
    ),
    [
      {
        description: 'A reflected skyline.',
        discordUserId: '823456789012345678',
        messageId: '423456789012345678',
        place: 1,
        threadId: '423456789012345678',
        title: 'City Reflection',
      },
    ],
  );
  const noWinnerMarker = await createCompetitionWinnerMarker(
    'pcc-competition:8de260c4-9e0b-4a58-a611-a19ff202c86e',
    2,
    [],
    'test-worker-secret',
  );
  assert.deepEqual(
    await readPersistedCompetitionResults(
      noWinnerMarker,
      entries,
      '8de260c4-9e0b-4a58-a611-a19ff202c86e',
      2,
      'test-worker-secret',
    ),
    [],
  );
  assert.equal(
    await readPersistedCompetitionResults(
      marker.replace('winners:423456789012345678', 'winners:none'),
      entries,
      '8de260c4-9e0b-4a58-a611-a19ff202c86e',
      2,
      'test-worker-secret',
    ),
    null,
  );
});

test('forum names are Discord-safe and bounded', () => {
  assert.equal(
    normalizeCompetitionForumName('  Night / Light!  '),
    'night-light',
  );
  assert.ok(normalizeCompetitionForumName('A'.repeat(200)).length <= 100);
});

test('archive overwrites remove member writes while preserving staff access', () => {
  const inherited = [
    { allow: String(64 + 2048), deny: '0', id: '123', type: 0 },
    { allow: '0', deny: '0', id: DISCORD_ROLE_IDS.admin, type: 0 },
  ];
  const [overwrite, staffOverwrite] = buildReadOnlyOverwrites(inherited, '123');
  assert.ok(overwrite);
  assert.equal(BigInt(overwrite.allow) & 64n, 0n);
  assert.notEqual(BigInt(overwrite.deny) & 64n, 0n);
  assert.notEqual(BigInt(overwrite.deny) & 274877906944n, 0n);
  assert.ok(staffOverwrite);
  assert.notEqual(BigInt(staffOverwrite.allow) & 64n, 0n);
  assert.notEqual(BigInt(staffOverwrite.allow) & 274877906944n, 0n);
});

test('vote tally overwrites temporarily hide the forum from members', () => {
  const guildId = '1182061172309106708';
  const inherited = [
    { allow: String(1_024n | 64n), deny: '0', id: guildId, type: 0 },
    {
      allow: String(1_024n | 64n),
      deny: '0',
      id: 'restricted-role',
      type: 0,
    },
    { allow: '0', deny: '0', id: DISCORD_ROLE_IDS.admin, type: 0 },
  ];

  const frozen = buildVoteTallyOverwrites(inherited, guildId);
  assert.equal(BigInt(frozen[0]!.allow) & 1_024n, 0n);
  assert.notEqual(BigInt(frozen[0]!.deny) & 1_024n, 0n);
  assert.equal(BigInt(frozen[1]!.allow) & 1_024n, 0n);
  assert.notEqual(BigInt(frozen[1]!.deny) & 1_024n, 0n);
  assert.notEqual(BigInt(frozen[2]!.allow) & 1_024n, 0n);
  assert.equal(BigInt(frozen[2]!.deny) & 1_024n, 0n);
});

test('active forum permissions match the competition lifecycle', () => {
  const base = [
    {
      allow: String(64n | 2_048n | 274_877_906_944n),
      deny: '0',
      id: '1182061172309106708',
      type: 0,
    },
    {
      allow: String(64n | 2_048n | 274_877_906_944n),
      deny: String(64n | 2_048n),
      id: 'restricted-role',
      type: 0,
    },
    { allow: '0', deny: '0', id: DISCORD_ROLE_IDS.admin, type: 0 },
  ];
  const original = structuredClone(base);

  const open = buildActiveCompetitionForumOverwrites(
    base,
    '1182061172309106708',
    'open',
  );
  const openEveryone = open[0]!;
  assert.notEqual(BigInt(openEveryone.allow) & 2_048n, 0n);
  assert.notEqual(BigInt(openEveryone.deny) & 64n, 0n);
  assert.notEqual(BigInt(openEveryone.deny) & 274_877_906_944n, 0n);
  assert.equal(BigInt(open[1]!.allow) & (64n | 2_048n | 274_877_906_944n), 0n);
  assert.notEqual(BigInt(open[1]!.deny) & 64n, 0n);
  assert.notEqual(BigInt(open[1]!.deny) & 2_048n, 0n);
  assert.notEqual(BigInt(open[2]!.allow) & 274_877_906_944n, 0n);

  const judging = buildActiveCompetitionForumOverwrites(
    base,
    '1182061172309106708',
    'judging',
  );
  const judgingEveryone = judging[0]!;
  assert.notEqual(BigInt(judgingEveryone.allow) & 64n, 0n);
  assert.equal(BigInt(judgingEveryone.deny) & 64n, 0n);
  assert.notEqual(BigInt(judgingEveryone.deny) & 2_048n, 0n);
  assert.notEqual(BigInt(judgingEveryone.deny) & 274_877_906_944n, 0n);
  assert.equal(
    BigInt(judging[1]!.allow) & (64n | 2_048n | 274_877_906_944n),
    0n,
  );
  assert.notEqual(BigInt(judging[1]!.deny) & 64n, 0n);
  assert.notEqual(BigInt(judging[1]!.deny) & 2_048n, 0n);
  assert.notEqual(BigInt(judging[2]!.allow) & 274_877_906_944n, 0n);

  const draft = buildActiveCompetitionForumOverwrites(
    base,
    '1182061172309106708',
    'draft',
  );
  assert.notEqual(BigInt(draft[0]!.deny) & 64n, 0n);
  assert.notEqual(BigInt(draft[0]!.deny) & 2_048n, 0n);
  assert.notEqual(BigInt(draft[0]!.deny) & 274_877_906_944n, 0n);
  assert.deepEqual(base, original);
});

test('open sync clears accepted entry reactions and survives repeated Discord 429s', async () => {
  const originalFetch = globalThis.fetch;
  const reactionPath =
    '/api/v10/channels/423456789012345678/messages/423456789012345678/reactions';
  let reactionAttempts = 0;
  const requestCounts = new Map<string, number>();

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const requestKey = `${init?.method ?? 'GET'} ${url.pathname}`;
    requestCounts.set(requestKey, (requestCounts.get(requestKey) ?? 0) + 1);
    if (url.pathname === reactionPath) {
      reactionAttempts += 1;
      if (reactionAttempts < 3) {
        return Response.json(
          { message: 'You are being rate limited.', retry_after: 0 },
          { status: 429 },
        );
      }
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname === '/api/v10/channels/323456789012345678' &&
      (init?.method ?? 'GET') === 'GET'
    ) {
      return Response.json({
        guild_id: '1182061172309106708',
        id: '323456789012345678',
        parent_id: '1512508504081039482',
        permission_overwrites: [],
        topic:
          'pcc-competition:8de260c4-9e0b-4a58-a611-a19ff202c86e;revision:1',
        type: 15,
      });
    }
    if (url.pathname === '/api/v10/channels/1512508504081039482') {
      return Response.json({
        id: '1512508504081039482',
        permission_overwrites: [],
      });
    }
    if (
      url.pathname === '/api/v10/channels/423456789012345678' &&
      (init?.method ?? 'GET') === 'GET'
    ) {
      return Response.json({
        id: '423456789012345678',
        parent_id: '323456789012345678',
        thread_metadata: { archived: true, locked: true },
      });
    }
    return Response.json({ id: url.pathname.split('/').at(-1) });
  };

  try {
    const result = await syncDiscordCompetition(
      {
        DISCORD_APPLICATION_ID: '723456789012345678',
        DISCORD_GUILD_ID: '1182061172309106708',
        DISCORD_TOKEN: 'test-token',
      } as Env,
      {
        competition: {
          description: null,
          entries: [
            {
              messageId: '423456789012345678',
              threadId: '423456789012345678',
            },
          ],
          forumChannelId: '323456789012345678',
          id: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
          results: [],
          status: 'open',
          statusMessageId: '523456789012345678',
          statusThreadId: '623456789012345678',
          submissionDeadline: '2026-09-30',
          syncRevision: 2,
          theme: 'Reflections',
          title: 'September Competition',
        },
        type: 'website.competition.sync',
      },
    );

    assert.equal(result.forumChannelId, '323456789012345678');
    assert.equal(reactionAttempts, 3);
    assert.equal(
      requestCounts.get('PATCH /api/v10/channels/323456789012345678'),
      1,
    );
    assert.equal(
      requestCounts.get('PATCH /api/v10/channels/623456789012345678'),
      1,
    );
    assert.equal(
      requestCounts.get(
        'PATCH /api/v10/channels/623456789012345678/messages/523456789012345678',
      ),
      1,
    );
    assert.equal(
      requestCounts.get('PATCH /api/v10/channels/423456789012345678'),
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('closed sync announces results without archiving the forum', async () => {
  const originalFetch = globalThis.fetch;
  const forumPath = '/api/v10/channels/323456789012345678';
  const requests: Request[] = [];

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);

    if (
      url.pathname === forumPath &&
      request.method === 'PATCH' &&
      requests.filter(
        (candidate) =>
          candidate.method === 'PATCH' &&
          new URL(candidate.url).pathname === forumPath,
      ).length === 1
    ) {
      return Response.json(
        { message: 'You are being rate limited.', retry_after: 0 },
        { status: 429 },
      );
    }
    if (url.pathname === forumPath && request.method === 'GET') {
      return Response.json({
        guild_id: '1182061172309106708',
        id: '323456789012345678',
        parent_id: '1512508504081039482',
        topic:
          'pcc-competition:8de260c4-9e0b-4a58-a611-a19ff202c86e;revision:1',
        type: 15,
      });
    }
    if (
      url.pathname === '/api/v10/channels/423456789012345678' &&
      request.method === 'GET'
    ) {
      return Response.json({
        id: '423456789012345678',
        parent_id: '323456789012345678',
        thread_metadata: { archived: false, locked: false },
      });
    }
    if (
      url.pathname ===
        `/api/v10/channels/423456789012345678/messages/423456789012345678/reactions/${encodeURIComponent(COMPETITION_VOTE_EMOJI)}` &&
      request.method === 'GET'
    ) {
      assert.equal(url.searchParams.get('type'), '0');
      return Response.json([
        { bot: true, id: '723456789012345678' },
        { id: '923456789012345671' },
        { id: '923456789012345672' },
        { id: '923456789012345673' },
        { id: '923456789012345674' },
      ]);
    }
    if (
      url.pathname ===
        `/api/v10/channels/${DISCORD_CHANNEL_IDS.competitionArchiveCategory}` &&
      request.method === 'GET'
    ) {
      return Response.json({
        id: DISCORD_CHANNEL_IDS.competitionArchiveCategory,
        permission_overwrites: [],
      });
    }
    return Response.json({ id: url.pathname.split('/').at(-1) });
  };

  try {
    await syncDiscordCompetition(
      {
        DISCORD_APPLICATION_ID: '723456789012345678',
        DISCORD_GUILD_ID: '1182061172309106708',
        DISCORD_TOKEN: 'test-token',
        WORKER_SECRET: 'test-worker-secret',
      } as Env,
      {
        competition: {
          description: null,
          entries: [
            {
              description: 'A reflected skyline.',
              discordUserId: '823456789012345678',
              messageId: '423456789012345678',
              threadId: '423456789012345678',
              title: 'City Reflection',
            },
          ],
          forumChannelId: '323456789012345678',
          id: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
          results: [],
          status: 'closed',
          statusMessageId: '523456789012345678',
          statusThreadId: '623456789012345678',
          submissionDeadline: '2026-09-30',
          syncRevision: 2,
          theme: 'Reflections',
          title: 'September Competition',
        },
        type: 'website.competition.sync',
      },
    );

    const forumUpdates = requests.filter(
      (request) =>
        request.method === 'PATCH' &&
        new URL(request.url).pathname === forumPath,
    );
    assert.equal(forumUpdates.length, 4);
    const firstForumBody = await forumUpdates[0]!.clone().json();
    const frozenForumBody = (await forumUpdates[1]!.json()) as Record<
      string,
      unknown
    >;
    const signedFrozenForumBody = (await forumUpdates[2]!.json()) as Record<
      string,
      unknown
    >;
    const forumBody = (await forumUpdates[3]!.json()) as Record<
      string,
      unknown
    >;
    assert.deepEqual(firstForumBody, frozenForumBody);
    assert.equal(frozenForumBody.default_reaction_emoji, null);
    assert.equal(frozenForumBody.name, 'september-competition');
    assert.equal('parent_id' in frozenForumBody, false);
    assert.ok(Array.isArray(frozenForumBody.permission_overwrites));
    assert.equal(
      frozenForumBody.topic,
      'pcc-competition:8de260c4-9e0b-4a58-a611-a19ff202c86e;revision:2',
    );
    const frozenEveryone = (
      frozenForumBody.permission_overwrites as Array<{
        allow: string;
        deny: string;
        id: string;
      }>
    ).find((overwrite) => overwrite.id === '1182061172309106708');
    assert.ok(frozenEveryone);
    assert.notEqual(BigInt(frozenEveryone.deny) & 1_024n, 0n);
    assert.match(
      String(signedFrozenForumBody.topic),
      /^pcc-competition:8de260c4-9e0b-4a58-a611-a19ff202c86e;winners:423456789012345678;signature:[a-f0-9]{64};revision:2$/,
    );
    assert.equal(forumBody.topic, signedFrozenForumBody.topic);
    const revealedEveryone = (
      forumBody.permission_overwrites as Array<{
        allow: string;
        deny: string;
        id: string;
      }>
    ).find((overwrite) => overwrite.id === '1182061172309106708');
    assert.ok(revealedEveryone);
    assert.equal(BigInt(revealedEveryone.deny) & 1_024n, 0n);
    const successfulFreezeIndex = requests.indexOf(forumUpdates[1]!);
    const voteReadIndex = requests.findIndex(
      (request) =>
        request.method === 'GET' &&
        new URL(request.url).pathname.includes('/reactions/'),
    );
    assert.ok(successfulFreezeIndex < voteReadIndex);
    assert.equal(
      requests.some(
        (request) =>
          request.method === 'GET' &&
          new URL(request.url).pathname ===
            `/api/v10/channels/${DISCORD_CHANNEL_IDS.competitionArchiveCategory}`,
      ),
      false,
    );
    const statusMessageUpdate = requests.find(
      (request) =>
        request.method === 'PATCH' &&
        new URL(request.url).pathname ===
          '/api/v10/channels/623456789012345678/messages/523456789012345678',
    );
    assert.ok(statusMessageUpdate);
    assert.ok(
      requests.indexOf(statusMessageUpdate) <
        requests.indexOf(forumUpdates[3]!),
    );
    const statusMessage = (await statusMessageUpdate.json()) as {
      embeds?: Array<{ fields?: Array<{ name?: string; value?: string }> }>;
    };
    const resultsField = statusMessage.embeds?.[0]?.fields?.find(
      (field) => field.name === 'Results',
    );
    assert.match(resultsField?.value ?? '', /City Reflection/);
    assert.match(resultsField?.value ?? '', /423456789012345678/);
    assert.match(resultsField?.value ?? '', /<@823456789012345678>/);
    assert.equal(
      requests.filter(
        (request) =>
          request.method === 'PUT' &&
          request.url.endsWith(`/reactions/${encodeURIComponent('1️⃣')}/@me`),
      ).length,
      1,
    );
    assert.equal(
      requests.some(
        (request) =>
          request.method === 'DELETE' &&
          new URL(request.url).pathname.endsWith('/reactions'),
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('competition sync parsing allows ending before results are published', () => {
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
  assert.doesNotThrow(() => parseInternalEvent(base));
});

test('competition sync parsing validates accepted entry Discord IDs', () => {
  const event = {
    competition: {
      description: null,
      entries: [
        {
          messageId: '423456789012345678',
          threadId: '423456789012345678',
        },
      ],
      forumChannelId: null,
      id: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
      results: [],
      status: 'open',
      statusMessageId: null,
      statusThreadId: null,
      submissionDeadline: '2026-09-30',
      syncRevision: 2,
      theme: null,
      title: 'September Competition',
    },
    type: 'website.competition.sync',
  };

  const parsed = parseInternalEvent(event);
  assert.equal(parsed.kind, 'competitionSync');
  if (parsed.kind !== 'competitionSync') {
    throw new Error('Expected a competition sync event.');
  }
  assert.deepEqual(parsed.event.competition.entries, event.competition.entries);
  const eventWithWinnerMetadata = {
    ...event,
    competition: {
      ...event.competition,
      entries: [
        {
          description: 'A reflected skyline.',
          discordUserId: '823456789012345678',
          messageId: '423456789012345678',
          threadId: '423456789012345678',
          title: 'City Reflection',
        },
      ],
    },
  };
  const parsedWithWinnerMetadata = parseInternalEvent(eventWithWinnerMetadata);
  assert.equal(parsedWithWinnerMetadata.kind, 'competitionSync');
  if (parsedWithWinnerMetadata.kind !== 'competitionSync') {
    throw new Error('Expected a competition sync event.');
  }
  assert.deepEqual(
    parsedWithWinnerMetadata.event.competition.entries,
    eventWithWinnerMetadata.competition.entries,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...event,
        competition: {
          ...event.competition,
          entries: [
            {
              discordUserId: '823456789012345678',
              messageId: '423456789012345678',
              threadId: '423456789012345678',
            },
          ],
        },
      }),
    /winner metadata is incomplete/,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...event,
        competition: {
          ...event.competition,
          entries: [{ messageId: 'bad', threadId: '423456789012345678' }],
        },
      }),
    /messageId/,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...event,
        competition: {
          ...event.competition,
          entries: [
            {
              messageId: '323456789012345678',
              threadId: '423456789012345678',
            },
          ],
        },
      }),
    /starter message/,
  );
  assert.throws(
    () =>
      parseInternalEvent({
        ...event,
        competition: {
          ...event.competition,
          entries: [...event.competition.entries, ...event.competition.entries],
        },
      }),
    /unique/,
  );
});

test('judging clears reactions and seeds the defined vote on available entries', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (
      url.pathname === '/api/v10/channels/323456789012345678' &&
      request.method === 'GET'
    ) {
      return Response.json({
        guild_id: '1182061172309106708',
        id: '323456789012345678',
        parent_id: '1512508504081039482',
        topic:
          'pcc-competition:8de260c4-9e0b-4a58-a611-a19ff202c86e;revision:1',
        type: 15,
      });
    }
    if (url.pathname === '/api/v10/channels/1512508504081039482') {
      return Response.json({
        id: '1512508504081039482',
        permission_overwrites: [],
      });
    }
    if (
      url.pathname === '/api/v10/channels/413456789012345678' &&
      request.method === 'GET'
    ) {
      return Response.json({ message: 'Unknown Channel' }, { status: 404 });
    }
    if (
      url.pathname === '/api/v10/channels/423456789012345678' &&
      request.method === 'GET'
    ) {
      return Response.json({
        id: '423456789012345678',
        parent_id: '323456789012345678',
        thread_metadata: { archived: false, locked: false },
      });
    }
    if (
      url.pathname ===
        '/api/v10/channels/423456789012345678/messages/423456789012345678' &&
      request.method === 'GET'
    ) {
      return Response.json({
        reactions: [
          { emoji: { id: null, name: COMPETITION_VOTE_EMOJI } },
          { emoji: { id: null, name: '🔥' } },
        ],
      });
    }
    return Response.json({ id: url.pathname.split('/').at(-1) });
  };

  try {
    await syncDiscordCompetition(
      {
        DISCORD_APPLICATION_ID: '723456789012345678',
        DISCORD_GUILD_ID: '1182061172309106708',
        DISCORD_TOKEN: 'test-token',
      } as Env,
      {
        competition: {
          description: null,
          entries: [
            {
              messageId: '413456789012345678',
              threadId: '413456789012345678',
            },
            {
              messageId: '423456789012345678',
              threadId: '423456789012345678',
            },
          ],
          forumChannelId: '323456789012345678',
          id: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
          results: [],
          status: 'judging',
          statusMessageId: '523456789012345678',
          statusThreadId: '623456789012345678',
          submissionDeadline: '2026-09-30',
          syncRevision: 2,
          theme: 'Reflections',
          title: 'September Competition',
        },
        type: 'website.competition.sync',
      },
    );

    const forumUpdate = requests.find(
      (request) =>
        new URL(request.url).pathname ===
          '/api/v10/channels/323456789012345678' && request.method === 'PATCH',
    );
    assert.ok(forumUpdate);
    const forumBody = (await forumUpdate.json()) as Record<string, unknown>;
    assert.deepEqual(forumBody.default_reaction_emoji, {
      emoji_name: COMPETITION_VOTE_EMOJI,
    });
    const reactionRequests = requests.filter(
      (request) =>
        request.method === 'PUT' && request.url.includes('/reactions/'),
    );
    assert.equal(reactionRequests.length, 1);
    assert.match(
      reactionRequests[0]!.url,
      new RegExp(`${encodeURIComponent(COMPETITION_VOTE_EMOJI)}/@me$`),
    );
    const cleanupRequests = requests.filter(
      (request) =>
        request.method === 'DELETE' && request.url.includes('/reactions/'),
    );
    assert.equal(cleanupRequests.length, 1);
    assert.match(cleanupRequests[0]!.url, /reactions\/%F0%9F%94%A5$/);
    assert.doesNotMatch(
      cleanupRequests[0]!.url,
      new RegExp(encodeURIComponent(COMPETITION_VOTE_EMOJI)),
    );
    const entryUnarchives = requests.filter(
      (request) =>
        request.method === 'PATCH' &&
        new URL(request.url).pathname ===
          '/api/v10/channels/423456789012345678',
    );
    assert.equal(entryUnarchives.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('competition archiving validates the forum and moves it to the archive category', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);

    if (
      url.pathname === '/api/v10/channels/323456789012345678' &&
      request.method === 'GET'
    ) {
      return Response.json({
        guild_id: '1182061172309106708',
        id: '323456789012345678',
        parent_id: DISCORD_CHANNEL_IDS.competitionActiveCategory,
        topic:
          'pcc-competition:8de260c4-9e0b-4a58-a611-a19ff202c86e;revision:2',
        type: 15,
      });
    }
    if (
      url.pathname ===
        `/api/v10/channels/${DISCORD_CHANNEL_IDS.competitionArchiveCategory}` &&
      request.method === 'GET'
    ) {
      return Response.json({
        id: DISCORD_CHANNEL_IDS.competitionArchiveCategory,
        permission_overwrites: [],
      });
    }
    return Response.json({ id: url.pathname.split('/').at(-1) });
  };

  try {
    assert.deepEqual(
      parseInternalEvent({
        competitionId: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
        forumChannelId: '323456789012345678',
        syncRevision: 2,
        type: 'website.competition.archive',
      }),
      {
        event: {
          competitionId: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
          forumChannelId: '323456789012345678',
          syncRevision: 2,
          type: 'website.competition.archive',
        },
        kind: 'competitionArchive',
      },
    );

    const result = await archiveDiscordCompetition(
      {
        DISCORD_APPLICATION_ID: '723456789012345678',
        DISCORD_GUILD_ID: '1182061172309106708',
        DISCORD_TOKEN: 'test-token',
      } as Env,
      {
        competitionId: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
        forumChannelId: '323456789012345678',
        syncRevision: 2,
        type: 'website.competition.archive',
      },
    );

    assert.deepEqual(result, { forumChannelId: '323456789012345678' });
    const archiveUpdate = requests.find(
      (request) =>
        request.method === 'PATCH' &&
        new URL(request.url).pathname ===
          '/api/v10/channels/323456789012345678',
    );
    assert.ok(archiveUpdate);
    const body = (await archiveUpdate.json()) as Record<string, unknown>;
    assert.equal(
      body.parent_id,
      DISCORD_CHANNEL_IDS.competitionArchiveCategory,
    );
    assert.equal(body.default_reaction_emoji, null);
    assert.ok(Array.isArray(body.permission_overwrites));
    assert.equal('name' in body, false);
    assert.equal('topic' in body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('competition archiving rejects malformed identity and revision fields', () => {
  const valid = {
    competitionId: '8de260c4-9e0b-4a58-a611-a19ff202c86e',
    forumChannelId: '323456789012345678',
    syncRevision: 2,
    type: 'website.competition.archive',
  };

  assert.throws(
    () => parseInternalEvent({ ...valid, competitionId: 'competition-1' }),
    /Competition ID/,
  );
  assert.throws(
    () => parseInternalEvent({ ...valid, forumChannelId: 'not-a-channel' }),
    /forumChannelId/,
  );
  assert.throws(
    () => parseInternalEvent({ ...valid, syncRevision: -1 }),
    /sync revision/,
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

test('judging accepts only the forum default voting reaction', async () => {
  const originalFetch = globalThis.fetch;
  const discordRequests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    discordRequests.push(new Request(input, init));
    return new Response(null, { status: 204 });
  };
  const env = {
    API_WORKER: {
      fetch: async () =>
        Response.json({ canReact: true, isEntry: true, status: 'judging' }),
    },
    DISCORD_TOKEN: 'test-token',
    INTERNAL_TOKEN: 'test-internal-token',
  } as unknown as Env;
  const baseEvent: GatewayInternalEvent = {
    channelId: '423456789012345678',
    eventType: 'MESSAGE_REACTION_ADD',
    guildId: '1182061172309106708',
    messageId: '423456789012345678',
    payload: {
      category_id: '1512508504081039482',
      parent_channel_id: '323456789012345678',
    },
    receivedAt: '2026-09-14T20:00:01.000Z',
    type: 'discord.gateway.event',
    userId: '123456789012345678',
  };

  try {
    await handleCompetitionGatewayEvent(
      {
        ...baseEvent,
        payload: { ...baseEvent.payload, emoji: { name: '🔥' } },
      },
      env,
    );
    await handleCompetitionGatewayEvent(
      {
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          emoji: { name: COMPETITION_VOTE_EMOJI },
        },
      },
      env,
    );
    await handleCompetitionGatewayEvent(
      {
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          emoji: { name: '🏆' },
          user: { bot: true, id: '723456789012345678' },
        },
        userId: '723456789012345678',
      },
      env,
    );

    assert.equal(discordRequests.length, 1);
    assert.equal(discordRequests[0]!.method, 'DELETE');
    assert.match(discordRequests[0]!.url, /reactions\/%F0%9F%94%A5\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
