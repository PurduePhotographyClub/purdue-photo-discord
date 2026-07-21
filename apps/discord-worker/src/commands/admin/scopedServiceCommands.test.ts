import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { InteractionType } from 'discord-interactions';
import type { ApplicationCommandInteraction, Env } from '../../discord/types';
import { darkroomStatsCommand } from './darkroomStats';
import { equipmentTermsMessageCommand } from './equipmentTermsMessage';
import { studioMessageCommand } from './studioMessage';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('studio-message sends the actor Discord ID to API scope authorization', async () => {
  const requests: Request[] = [];
  const response = await studioMessageCommand.execute(
    commandInteraction('studio-message'),
    apiEnv(async (request) => {
      requests.push(request);
      return Response.json({
        channelId: 'studio-channel',
        messageId: 'studio-message',
        ok: true,
      });
    }),
  );

  assert.equal(requests.length, 1);
  assert.equal(
    new URL(requests[0]!.url).pathname,
    '/api/v1/admin/studio/schedule-message',
  );
  assert.deepEqual(await requests[0]!.clone().json(), {
    actorDiscordId: 'scoped-manager',
  });
  assert.match(
    response.data?.content ?? '',
    /Studio scheduling message synced/,
  );
});

test('darkroom-stats sends the actor Discord ID without a local Executive pre-gate', async () => {
  const requests: Request[] = [];
  const response = await darkroomStatsCommand.execute(
    commandInteraction('darkroom-stats'),
    apiEnv(async (request) => {
      requests.push(request);
      return Response.json({
        discordMemberCount: 100,
        ok: true,
        rollCount: 20,
        userCount: 10,
        voiceChannelName: '100 Members',
      });
    }),
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(await requests[0]!.clone().json(), {
    actorDiscordId: 'scoped-manager',
  });
  assert.equal(response.data?.embeds?.[0]?.title, 'Darkroom Stats Synced');
});

test('equipment-terms-message checks API scope before posting to Discord', async () => {
  const apiRequests: Request[] = [];
  const discordRequests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    discordRequests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return Response.json({ id: 'terms-message' });
  };

  const response = await equipmentTermsMessageCommand.execute(
    commandInteraction('equipment-terms-message'),
    apiEnv(async (request) => {
      apiRequests.push(request);
      return Response.json({ allowed: true, ok: true });
    }, true),
  );

  assert.equal(apiRequests.length, 1);
  assert.equal(
    new URL(apiRequests[0]!.url).pathname,
    '/api/v1/service-managers/access-by-discord',
  );
  assert.deepEqual(await apiRequests[0]!.clone().json(), {
    discordId: 'scoped-manager',
    scope: 'equipment',
  });
  assert.deepEqual(discordRequests, [
    'POST /api/v10/channels/1512505024792760421/messages',
  ]);
  assert.match(response.data?.content ?? '', /Equipment terms message posted/);
});

test('equipment-terms-message does not post when API denies its scope', async () => {
  let discordRequests = 0;
  globalThis.fetch = async () => {
    discordRequests += 1;
    return Response.json({ id: 'unexpected-message' });
  };

  const response = await equipmentTermsMessageCommand.execute(
    commandInteraction('equipment-terms-message'),
    apiEnv(
      async () => Response.json({ allowed: false }, { status: 403 }),
      true,
    ),
  );

  assert.equal(discordRequests, 0);
  assert.match(response.data?.content ?? '', /not authorized/i);
});

function commandInteraction(name: string): ApplicationCommandInteraction {
  return {
    data: { name },
    member: { roles: [], user: { id: 'scoped-manager' } },
    type: InteractionType.APPLICATION_COMMAND,
  };
}

function apiEnv(
  fetcher: (request: Request) => Promise<Response>,
  includeDiscord = false,
): Env {
  return {
    API_WORKER: { fetch: fetcher } as unknown as Fetcher,
    ...(includeDiscord ? { DISCORD_TOKEN: 'discord-token' } : {}),
  };
}
