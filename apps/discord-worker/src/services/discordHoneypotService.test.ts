import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { GatewayInternalEvent } from '@pccbot/shared';
import type { Env } from '../discord/types';
import {
  HONEYPOT_WARNING_MESSAGE,
  handleDiscordHoneypotMessage,
  postDiscordHoneypotWarningMessage,
} from './discordHoneypotService';
import { handleGatewayEvent } from './gatewayEventService';

const HONEYPOT_CHANNEL_ID = '1519110560925483008';
const HONEYPOT_ROLE_ID = '1515784633374212247';
const SAFE_CHANNEL_ID = '1524160150624010331';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('postDiscordHoneypotWarningMessage posts the exact warning in the honeypot channel', async () => {
  let postBody: Record<string, unknown> | null = null;
  let requestedPath = '';

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requestedPath = `${init?.method ?? 'GET'} ${url.pathname}`;
    postBody = JSON.parse(String(init?.body));

    return Response.json({ id: 'warning-message' });
  };

  const result = await postDiscordHoneypotWarningMessage(createEnv());

  assert.equal(
    requestedPath,
    `POST /api/v10/channels/${HONEYPOT_CHANNEL_ID}/messages`,
  );
  assert.deepEqual(postBody, {
    allowed_mentions: { parse: [] },
    content: HONEYPOT_WARNING_MESSAGE,
  });
  assert.equal(result.channelId, HONEYPOT_CHANNEL_ID);
  assert.equal(result.messageId, 'warning-message');
});

test('handleDiscordHoneypotMessage deletes a real user message and applies the honeypot role', async () => {
  const requests: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);

    return new Response(null, { status: 204 });
  };

  const result = await handleDiscordHoneypotMessage(
    createMessageCreateEvent({
      authorBot: false,
      channelId: HONEYPOT_CHANNEL_ID,
    }),
    createEnv(),
  );

  assert.deepEqual(requests, [
    `DELETE /api/v10/channels/${HONEYPOT_CHANNEL_ID}/messages/message-123`,
    `PUT /api/v10/guilds/guild-123/members/user-123/roles/${HONEYPOT_ROLE_ID}`,
  ]);
  assert.deepEqual(result, { handled: true });
});

test('handleGatewayEvent listens for honeypot messages', async () => {
  const requests: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);

    return new Response(null, { status: 204 });
  };

  const result = await handleGatewayEvent(
    createMessageCreateEvent({
      authorBot: false,
      channelId: HONEYPOT_CHANNEL_ID,
    }),
    createEnv(),
  );

  assert.deepEqual(requests, [
    `DELETE /api/v10/channels/${HONEYPOT_CHANNEL_ID}/messages/message-123`,
    `PUT /api/v10/guilds/guild-123/members/user-123/roles/${HONEYPOT_ROLE_ID}`,
  ]);
  assert.deepEqual(result, { handled: true });
});

test('handleDiscordHoneypotMessage ignores bot messages in the honeypot channel', async () => {
  let requestCount = 0;

  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(null, { status: 204 });
  };

  const result = await handleDiscordHoneypotMessage(
    createMessageCreateEvent({
      authorBot: true,
      channelId: HONEYPOT_CHANNEL_ID,
    }),
    createEnv(),
  );

  assert.equal(requestCount, 0);
  assert.deepEqual(result, { handled: false });
});

test('handleDiscordHoneypotMessage ignores messages in the safe channel', async () => {
  let requestCount = 0;

  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(null, { status: 204 });
  };

  const result = await handleDiscordHoneypotMessage(
    createMessageCreateEvent({
      authorBot: false,
      channelId: SAFE_CHANNEL_ID,
    }),
    createEnv(),
  );

  assert.equal(requestCount, 0);
  assert.deepEqual(result, { handled: false });
});

function createEnv(): Env {
  return {
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_TOKEN: 'test-discord-token',
  };
}

function createMessageCreateEvent(input: {
  authorBot: boolean;
  channelId: string;
}): GatewayInternalEvent {
  return {
    channelId: input.channelId,
    eventType: 'MESSAGE_CREATE',
    guildId: 'guild-123',
    messageId: 'message-123',
    payload: {
      author: {
        bot: input.authorBot,
        id: 'user-123',
      },
      channel_id: input.channelId,
      guild_id: 'guild-123',
      id: 'message-123',
    },
    receivedAt: '2026-07-07T00:00:00.000Z',
    type: 'discord.gateway.event',
    userId: 'user-123',
  };
}
