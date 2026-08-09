import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  InteractionResponseFlags,
  InteractionType,
  MessageComponentTypes,
} from 'discord-interactions';
import type { ComponentInteraction, Env } from '../discord/types';
import {
  JOBS_101_GUIDE_CONTENT,
  JOBS_101_MESSAGE_CHANNEL_ID,
  JOBS_ACCESS_ACCEPT_CUSTOM_ID,
  JOBS_ACCESS_ROLE_ID,
  handleJobsAccessButton,
  isJobsAccessButtonCustomId,
  postJobs101Messages,
} from './discordJobsAccessService';
import { handleButtonInteraction } from '../components/buttons';
import { DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION } from '../config/discord-role-ids';
import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { dispatchInternalEvent } from '../internal-events/dispatcher';
import { parseInternalEvent } from '../internal-events/parser';

const EXPECTED_JOBS_101_GUIDE = [
  '# 📸 JOBS 101',
  '',
  '## ✅ GENERAL TIPS',
  '',
  '- Agree on the deliverables before you accept: image type, final count, and deadline.',
  '- Decide how and when you will be paid. For Purdue student organizations, allow at least two weeks for BOSO payments.',
  '- Do not promise RAW files unless the job calls for them.',
  '- You keep the copyright unless you transfer it in writing. Get permission before using client photos in your portfolio or on social media, and set clear usage rights for commercial work.',
  '',
  '## 💬 COMMUNICATION',
  '',
  '- Confirm the plan 24 hours before the shoot.',
  '- Tell the client when you arrive, thank them afterward, and share editing updates with a realistic ETA.',
  '- If something changes or takes longer than expected, say so early. Silence makes clients worry.',
  '',
  '## 📅 COVERING EVENTS',
  '',
  '- Arrive early when possible so you can learn the schedule, key people, and where the photos will be used.',
  '- Shoot vertically for social media and horizontally by default elsewhere.',
  '- Watch your timing around talking and eating. Use bursts, flattering angles, and tighter framing to avoid awkward moments or empty-looking rooms.',
  '- Dress for the event. Avoid bright colors and white during performances.',
  "- Be confident, ask useful questions, stay out of the way, and make the organizer's job easier.",
  '',
  '## 📄 CONTRACTS AND LATE ARRIVALS',
  '',
  '- Read every line and put every change or promise in writing.',
  '- Ask for revisions when the contract does not match what you agreed to.',
  '- Set late, cancellation, and deposit terms before the job.',
  '- Protect your time and do not agree to terms you cannot enforce.',
  '',
  'Read the full Jobs 101 guide: https://wiki.purduephotoclub.org/jobs/',
].join('\n');

const originalFetch = globalThis.fetch;
const MEMBER_ROLE_ID =
  DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION.memberRoleId;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('Jobs 101 uses concise bullets under the existing headings and links the full guide', () => {
  assert.equal(JOBS_101_GUIDE_CONTENT, EXPECTED_JOBS_101_GUIDE);
});

test('postJobs101Messages uses readable normal messages within Discord limits', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(
      url.pathname,
      `/api/v10/channels/${JOBS_101_MESSAGE_CHANNEL_ID}/messages`,
    );
    assert.equal(init?.method, 'POST');
    requestBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `message-${requestBodies.length}` });
  };

  const result = await postJobs101Messages(createEnv());
  const guideBodies = requestBodies.slice(0, -1);
  const acknowledgementBody = requestBodies.at(-1);

  assert.equal(guideBodies.length, 1);
  assert.equal(
    guideBodies.map((body) => String(body.content)).join(''),
    EXPECTED_JOBS_101_GUIDE,
  );
  assert.equal(
    guideBodies.every(
      (body) =>
        typeof body.content === 'string' &&
        body.content.length <= 2_000 &&
        !/^#{1,6} .+$/u.test(body.content.trimEnd().split('\n').at(-1) ?? '') &&
        !('embeds' in body) &&
        !('components' in body),
    ),
    true,
  );
  assert.equal(
    String(acknowledgementBody?.content).startsWith(
      '## ✅ JOBS 101 TERMS AND CONDITIONS',
    ),
    true,
  );
  assert.equal('embeds' in (acknowledgementBody ?? {}), false);
  assert.deepEqual(
    (
      acknowledgementBody?.components as Array<{
        components: Array<{ custom_id: string; label: string }>;
      }>
    )[0]?.components[0],
    {
      custom_id: JOBS_ACCESS_ACCEPT_CUSTOM_ID,
      label: 'I have read and accept',
      style: 3,
      type: 2,
    },
  );
  assert.deepEqual(result, {
    channelId: JOBS_101_MESSAGE_CHANNEL_ID,
    messageIds: requestBodies.map((_, index) => `message-${index + 1}`),
  });
});

test('new photographer requests mention only the Jobs role in job channels', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `message-${requestBodies.length}` });
  };

  for (const channelId of [
    DISCORD_CHANNEL_IDS.photographerRequestsIndividual,
    DISCORD_CHANNEL_IDS.photographerRequestsOrganization,
  ]) {
    await dispatchInternalEvent(
      parseInternalEvent({
        channelId,
        content: 'New photographer request posted!',
        type: 'website.photographer_request.create',
      }),
      createEnv(),
    );
  }

  await dispatchInternalEvent(
    parseInternalEvent({
      channelId: DISCORD_CHANNEL_IDS.wiki,
      content: 'New photographer request posted!',
      type: 'website.photographer_request.create',
    }),
    createEnv(),
  );

  for (const body of requestBodies.slice(0, 2)) {
    assert.equal(
      body.content,
      `<@&${JOBS_ACCESS_ROLE_ID}>\nNew photographer request posted!`,
    );
    assert.deepEqual(body.allowed_mentions, {
      parse: [],
      roles: [JOBS_ACCESS_ROLE_ID],
    });
  }

  assert.equal(requestBodies[2]?.content, 'New photographer request posted!');
  assert.deepEqual(requestBodies[2]?.allowed_mentions, { parse: [] });
});

test('the Jobs 101 acceptance button grants the Jobs role', async () => {
  const requests: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (init?.method === undefined || init.method === 'GET') {
      return Response.json([
        { id: JOBS_ACCESS_ROLE_ID, permissions: '0', position: 1 },
      ]);
    }
    return new Response(null, { status: 204 });
  };

  const response = await handleJobsAccessButton(
    componentInteraction([MEMBER_ROLE_ID]),
    createEnv(),
  );

  assert.deepEqual(requests, [
    'GET /api/v10/guilds/guild-123/roles',
    `PUT /api/v10/guilds/guild-123/members/member-123/roles/${JOBS_ACCESS_ROLE_ID}`,
  ]);
  assert.equal(
    response.data?.content,
    'You have confirmed that you read Jobs 101. You now have access to the job posting channels.',
  );
  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
});

test('the shared button dispatcher routes the Jobs 101 acceptance button', async () => {
  const requests: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (init?.method === undefined || init.method === 'GET') {
      return Response.json([
        { id: JOBS_ACCESS_ROLE_ID, permissions: '0', position: 1 },
      ]);
    }
    return new Response(null, { status: 204 });
  };

  const response = await handleButtonInteraction(
    componentInteraction([MEMBER_ROLE_ID]),
    createEnv(),
  );

  assert.deepEqual(requests, [
    'GET /api/v10/guilds/guild-123/roles',
    `PUT /api/v10/guilds/guild-123/members/member-123/roles/${JOBS_ACCESS_ROLE_ID}`,
  ]);
  assert.equal(
    response.data?.content,
    'You have confirmed that you read Jobs 101. You now have access to the job posting channels.',
  );
});

test('the Jobs 101 acceptance button is idempotent for existing role members', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(null, { status: 204 });
  };

  const response = await handleJobsAccessButton(
    componentInteraction([MEMBER_ROLE_ID, JOBS_ACCESS_ROLE_ID]),
    createEnv(),
  );

  assert.equal(requestCount, 0);
  assert.equal(
    response.data?.content,
    'You already have access to the job posting channels.',
  );
});

test('the Jobs 101 acceptance button rejects members without the PPC Member role', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(null, { status: 204 });
  };

  const response = await handleJobsAccessButton(
    componentInteraction(),
    createEnv(),
  );

  assert.equal(requestCount, 0);
  assert.equal(
    response.data?.content,
    'You need the PPC Member role before you can access the job posting channels.',
  );
});

test('the Jobs 101 acceptance button is limited to the configured guild and channel', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(null, { status: 204 });
  };

  for (const interaction of [
    { ...componentInteraction([MEMBER_ROLE_ID]), guild_id: 'other-guild' },
    { ...componentInteraction([MEMBER_ROLE_ID]), channel_id: 'other-channel' },
  ]) {
    const response = await handleJobsAccessButton(interaction, createEnv());
    assert.equal(
      response.data?.content,
      'This Jobs 101 button is not valid here.',
    );
  }

  assert.equal(requestCount, 0);
});

test('the Jobs role must declare safe Discord permissions', async () => {
  for (const permissions of [
    undefined,
    (1n << 17n).toString(),
    (1n << 28n).toString(),
  ]) {
    globalThis.fetch = async () =>
      Response.json([
        {
          id: JOBS_ACCESS_ROLE_ID,
          ...(permissions === undefined ? {} : { permissions }),
          position: 1,
        },
      ]);

    const response = await handleJobsAccessButton(
      componentInteraction([MEMBER_ROLE_ID]),
      createEnv(),
    );

    assert.equal(
      response.data?.content,
      'I could not give you access to the job posting channels. Please contact an Executive.',
    );
  }
});

test('the Jobs 101 acceptance button rejects interactions without a user ID', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(null, { status: 204 });
  };

  const response = await handleJobsAccessButton(
    {
      data: {
        component_type: MessageComponentTypes.BUTTON,
        custom_id: JOBS_ACCESS_ACCEPT_CUSTOM_ID,
      },
      type: InteractionType.MESSAGE_COMPONENT,
    },
    createEnv(),
  );

  assert.equal(requestCount, 0);
  assert.equal(
    response.data?.content,
    'I could not identify your Discord account.',
  );
});

test('the Jobs 101 acceptance button returns a safe error if Discord rejects the role', async () => {
  globalThis.fetch = async () =>
    Response.json({ message: 'Missing Permissions' }, { status: 403 });

  const response = await handleJobsAccessButton(
    componentInteraction([MEMBER_ROLE_ID]),
    createEnv(),
  );

  assert.equal(
    response.data?.content,
    'I could not give you access to the job posting channels. Please contact an Executive.',
  );
});

test('only the Jobs 101 acceptance custom ID is recognized', () => {
  assert.equal(isJobsAccessButtonCustomId(JOBS_ACCESS_ACCEPT_CUSTOM_ID), true);
  assert.equal(isJobsAccessButtonCustomId('jobs_access:other'), false);
});

function componentInteraction(roles: string[] = []): ComponentInteraction {
  return {
    channel_id: JOBS_101_MESSAGE_CHANNEL_ID,
    data: {
      component_type: MessageComponentTypes.BUTTON,
      custom_id: JOBS_ACCESS_ACCEPT_CUSTOM_ID,
    },
    guild_id: 'guild-123',
    member: {
      roles,
      user: { id: 'member-123' },
    },
    type: InteractionType.MESSAGE_COMPONENT,
  };
}

function createEnv(): Env {
  return {
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_TOKEN: 'discord-token',
  };
}
