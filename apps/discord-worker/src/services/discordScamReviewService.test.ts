import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InteractionResponseFlags,
  InteractionType,
  MessageComponentTypes,
} from 'discord-interactions';
import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import type { ComponentInteraction, Env } from '../discord/types';
import { shouldDeferDiscordInteraction } from '../routes/discordInteractions';
import {
  handleDiscordScamReviewButton,
  isDiscordScamReviewButtonCustomId,
} from './discordScamReviewService';

const GUILD_ID = '1182061172309106708';
const REVIEW_ID = '1535080862603808808';
const ALERT_MESSAGE_ID = '1536065199889584209';
const ACTOR_ID = '1063962284386439199';

test('an Executive can restore access through the signed Gateway API', async () => {
  let requestUrl = '';
  let requestBody: unknown;
  const env: Env = {
    DISCORD_GUILD_ID: GUILD_ID,
    GATEWAY_SERVICE: {
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body));
        assert.match(
          new Headers(init?.headers).get('x-pccbot-signature') ?? '',
          /^sha256=[a-f0-9]{64}$/u,
        );
        return Response.json({
          message: 'Clown removed; RealRaw restored; user notified.',
          ok: true,
          status: 'restored',
        });
      },
    },
    WORKER_SECRET: 'test-secret',
  };
  const interaction = createInteraction('restore', [
    DISCORD_ROLE_IDS.executive,
  ]);

  const response = await handleDiscordScamReviewButton(interaction, env);

  assert.equal(requestUrl, 'http://gateway.internal/scam-review');
  assert.deepEqual(requestBody, {
    action: 'restore',
    actorId: ACTOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: REVIEW_ID,
  });
  assert.equal(
    response.data?.content,
    'Clown removed; RealRaw restored; user notified.',
  );
  assert.equal(
    Number(response.data?.flags) & InteractionResponseFlags.EPHEMERAL,
    InteractionResponseFlags.EPHEMERAL,
  );
});

test('rejects nonstaff and wrong-channel scam review controls without calling the Gateway', async () => {
  let gatewayCalls = 0;
  const env: Env = {
    DISCORD_GUILD_ID: GUILD_ID,
    GATEWAY_SERVICE: {
      fetch: async () => {
        gatewayCalls += 1;
        return Response.json({
          message: 'unexpected',
          ok: true,
          status: 'reviewed',
        });
      },
    },
    WORKER_SECRET: 'test-secret',
  };

  const nonstaff = await handleDiscordScamReviewButton(
    createInteraction('restore', []),
    env,
  );
  const wrongChannel = await handleDiscordScamReviewButton(
    {
      ...createInteraction('restore', [DISCORD_ROLE_IDS.admin]),
      channel_id: '1512507610186907648',
    },
    env,
  );

  assert.match(nonstaff.data?.content ?? '', /Admin or Executive/u);
  assert.match(wrongChannel.data?.content ?? '', /alert channel/u);
  assert.equal(gatewayCalls, 0);
});

test('recognizes only strict scam review IDs and defers their interaction', () => {
  const interaction = createInteraction('reviewed', [
    DISCORD_ROLE_IDS.executive,
  ]);

  assert.equal(
    isDiscordScamReviewButtonCustomId(`scam-review:reviewed:${REVIEW_ID}`),
    true,
  );
  assert.equal(
    isDiscordScamReviewButtonCustomId('scam-review:restore:not-valid'),
    false,
  );
  assert.equal(
    isDiscordScamReviewButtonCustomId(`scam-review:restore:${REVIEW_ID}:extra`),
    false,
  );
  assert.equal(shouldDeferDiscordInteraction(interaction), true);
});

function createInteraction(
  action: 'restore' | 'reviewed',
  roles: string[],
): ComponentInteraction {
  return {
    channel_id: DISCORD_CHANNEL_IDS.scamAlerts,
    data: {
      component_type: MessageComponentTypes.BUTTON,
      custom_id: `scam-review:${action}:${REVIEW_ID}`,
    },
    guild_id: GUILD_ID,
    member: { roles, user: { id: ACTOR_ID } },
    message: { id: ALERT_MESSAGE_ID },
    type: InteractionType.MESSAGE_COMPONENT,
  };
}
