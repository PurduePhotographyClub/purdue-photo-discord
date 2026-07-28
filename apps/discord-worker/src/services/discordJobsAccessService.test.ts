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
  'Before accepting a job, make sure that you know exactly what you are getting into. The first thing to keep in mind is delivery: what is the client expecting from you? Make sure that both you and the client agree upon the type of images, the number of images, and by what time the client will receive the images. While it is generally unadvisable to deliver raw pictures, this can vary based on the type of job and client requests. Second, ensure that both you and the client are on the same page regarding payment. Do you prefer to charge hourly, or by number of final images? When are you to receive the payment–before delivering the images, or after? If you are being hired by another student organization, keep in mind that BOSO takes at least two weeks to do anything. This will impact the timing of your payment. Lastly, understand how the photos will be used in the future. As the photographer, you own the copyright to every image you take unless explicitly transferred in writing. Paying for a photoshoot does not automatically give the client ownership of the copyright or unlimited usage rights. Most, if not all, of the jobs that you might accept through PPC will be for personal use, so explicitly outlining usage rights to the pictures is typically not needed. However, if you intend to use any images for your portfolio or social media, you must obtain permission from the client to do so. In the event that the images you are taking will be for commercial use, then you might want to be more specific for how long and for what purpose your client can use your images.',
  '',
  '## 💬 COMMUNICATION',
  '',
  "The number one rule of doing business is to satisfy the client. This is cheesy, but unfortunately that’s how it goes, so you need to make sure you are communicating as frequently as possible. Double check plans 24 hours before, let them know when you’re there, send a thank you when it's over, etc. Clients are not going to be pissed if you’re taking more time than expected to edit photos as long as you’re frequently updating them with an ETA. If you leave them sitting in their own thoughts,  they’re just going to get anxious and think you’re scamming them, which leads to a bad review for you.",
  '',
  '## 📅 COVERING EVENTS',
  '',
  "Showing up early and leaving late (when possible) is generally good advice, but is even more important when shooting events. It's more likely to get you recommendations, repeat business, and sometimes even a bonus. While you should establish as much as possible before the event, showing up early gives you more time to chat with the organizer of the event. Learn the schedule, people of importance, and where the photos will be used (if for social media, shoot vertically, default to horizontal otherwise). Learn to time people talking and eating, and take bursts when they do–you don't want a photo of someone with food in their mouth. Always make sure everyone is flattering in a photo, and try to minimize empty space (empty seats and undercrowded rooms make it seem like an event had low turn out, cover that up with careful composition and the use of longer focal lengths). An event organizer is stressing about a million things–if you show up early, ask questions, are confident, and stay out of people's way, the organizer will not need to worry about you. That is worth more to them than a pretty picture, and will win you a lot of leeway with final output; sometimes lighting and venue is shit, the photos will be bad and you can't fix that. Always dress appropriately (if unsure, lean on the side of overdressing). Avoid bright colors or white especially if it's during a performance; stage lighting will bounce off and be super annoying to guests. Again–can’t stress this enough–your client liking and trusting you is more important than the quality of your photos.",
  '',
  '## 📄 CONTRACTS AND LATE ARRIVALS',
  '',
  "The number one rule of writing contracts is to CYA (cover your ass). Read every single line, and if you or the other party decide to change anything, always request to have it in writing. Never feel bad for asking the client to revise the contract so it matches what they promised you. Clients are paying you for your time, so it’s recommended having a late/cancellation policy in place in your contract. Personally, I charge 50% of my hourly rate for every hour that they’re late, but it's up to you. It’s also good to set up a deposit clause in your contract if people end up cancelling. Again, CYA and don’t let people take advantage of your time.",
].join('\n');

const originalFetch = globalThis.fetch;
const MEMBER_ROLE_ID =
  DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION.memberRoleId;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('Jobs 101 uses Discord Markdown headings around the supplied guidance', () => {
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

  assert.equal(guideBodies.length > 1, true);
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
