import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayIntentBits, Partials } from 'discord.js';
import { readGatewayConfig } from './config.js';

const BASE_ENV = {
  DISCORD_TOKEN: 'test-token',
  WORKER_BASE_URL: 'https://discord-worker.example.com',
  WORKER_SECRET: 'test-worker-secret',
};

test('keeps message content unavailable when scam moderation is disabled', () => {
  const config = readGatewayConfig(BASE_ENV);

  assert.equal(config.scamModeration.enabled, false);
  assert.equal(
    config.intents.includes(GatewayIntentBits.MessageContent),
    false,
  );
});

test('enables local content inspection without forwarding message content', () => {
  const config = readGatewayConfig({
    ...BASE_ENV,
    DISCORD_GUILD_ID: '1182061172309106708',
    DISCORD_SCAM_ALERT_CHANNEL_ID: '1232870129000386620',
    SCAM_MODERATION_ENABLED: 'true',
  });

  assert.equal(config.forwardMessages, false);
  assert.equal(config.forwardMessageContent, false);
  assert.equal(config.intents.includes(GatewayIntentBits.GuildMessages), true);
  assert.equal(config.intents.includes(GatewayIntentBits.MessageContent), true);
  assert.deepEqual(config.scamModeration, {
    alertChannelId: '1232870129000386620',
    enabled: true,
    excludedChannelIds: new Set([
      '1519110560925483008',
      '1519110699786305798',
      '1232870129000386620',
    ]),
    guildId: '1182061172309106708',
    protectedRoleIds: new Set(['1364457359061155870', '1198569577383198730']),
    restrictedRoleId: '1515784633374212247',
    verifiedRoleId: '1503180707550199920',
  });
});

test('keeps message partials enabled for edited scam inspection without reactions', () => {
  const config = readGatewayConfig({
    ...BASE_ENV,
    DISCORD_GUILD_ID: '1182061172309106708',
    DISCORD_SCAM_ALERT_CHANNEL_ID: '1232870129000386620',
    FORWARD_REACTION_EVENTS: 'false',
    SCAM_MODERATION_ENABLED: 'true',
  });

  assert.deepEqual(config.partials, [Partials.Message, Partials.Channel]);
});

test('rejects content forwarding or missing private alerts when moderation is enabled', () => {
  assert.throws(
    () =>
      readGatewayConfig({
        ...BASE_ENV,
        DISCORD_GUILD_ID: '1182061172309106708',
        FORWARD_MESSAGE_CONTENT: 'true',
        SCAM_MODERATION_ENABLED: 'true',
      }),
    /DISCORD_SCAM_ALERT_CHANNEL_ID is required/u,
  );
  assert.throws(
    () =>
      readGatewayConfig({
        ...BASE_ENV,
        DISCORD_GUILD_ID: '1182061172309106708',
        DISCORD_SCAM_ALERT_CHANNEL_ID: '1232870129000386620',
        FORWARD_MESSAGE_CONTENT: 'true',
        SCAM_MODERATION_ENABLED: 'true',
      }),
    /must stay disabled/u,
  );
});

test('rejects an enabled moderation config without one exact guild', () => {
  assert.throws(
    () =>
      readGatewayConfig({
        ...BASE_ENV,
        SCAM_MODERATION_ENABLED: 'true',
      }),
    /DISCORD_GUILD_ID is required/u,
  );
});

test('rejects equal or malformed moderation role IDs', () => {
  assert.throws(
    () =>
      readGatewayConfig({
        ...BASE_ENV,
        DISCORD_GUILD_ID: '1182061172309106708',
        DISCORD_SCAM_ROLE_ID: '1503180707550199920',
        DISCORD_VERIFIED_ROLE_ID: '1503180707550199920',
        SCAM_MODERATION_ENABLED: 'true',
      }),
    /must be different/u,
  );
  assert.throws(
    () =>
      readGatewayConfig({
        ...BASE_ENV,
        DISCORD_GUILD_ID: 'not-a-snowflake',
        SCAM_MODERATION_ENABLED: 'true',
      }),
    /valid Discord snowflake/u,
  );
});
