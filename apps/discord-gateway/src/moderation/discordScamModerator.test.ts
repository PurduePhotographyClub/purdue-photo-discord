import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client, Message } from 'discord.js';
import type { GatewayScamModerationConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { createDiscordScamModerator } from './discordScamModerator.js';

const GUILD_ID = '1182061172309106708';
const CHANNEL_ID = '1182061172309106709';
const MESSAGE_ID = '1535080862603808808';
const USER_ID = '1351727646211313784';
const SCAM_ROLE_ID = '1515784633374212247';
const VERIFIED_ROLE_ID = '1503180707550199920';
const ALERT_CHANNEL_ID = '1232870129000386620';

test('validates Discord roles before deleting and quarantining a scam message', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls);
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');

  assert.equal(moderator.getHealth().ready, true);
  assert.deepEqual(calls, [
    `delete:${MESSAGE_ID}`,
    `remove:${VERIFIED_ROLE_ID}`,
    `add:${SCAM_ROLE_ID}`,
    `announce:${CHANNEL_ID}`,
    `alert:${ALERT_CHANNEL_ID}`,
  ]);
  assert.deepEqual(fixture.announcements, [
    {
      allowedMentions: { parse: [] },
      content: '🚨 Likely scam removed. Nice try. 🤡',
    },
  ]);
  assert.doesNotMatch(fixture.alerts.join('\n'), /MacBook|WhatsApp|346/u);
  assert.match(fixture.alerts[0] ?? '', /giveaway scam detected/u);
});

test('disables moderation when the Clown role gains guild permissions', async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const fixture = createDiscordFixture(calls, { restrictedPermissions: 1n });
  const moderator = createDiscordScamModerator(
    createConfig(),
    createLogger(errors),
  );

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');

  assert.equal(moderator.getHealth().ready, false);
  assert.match(moderator.getHealth().lastFailure ?? '', /guild permissions/u);
  assert.deepEqual(calls, []);
  assert.deepEqual(errors, ['Scam moderation failed its startup checks.']);
});

test('does not announce when Discord returns a non-message 404', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls, {
    deleteError: { code: 10_003, status: 404 },
  });
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');

  assert.deepEqual(calls, [
    `delete:${MESSAGE_ID}`,
    `remove:${VERIFIED_ROLE_ID}`,
    `add:${SCAM_ROLE_ID}`,
    `alert:${ALERT_CHANNEL_ID}`,
  ]);
  assert.equal(moderator.getHealth().lastFailure, 'delete_message');
  assert.match(fixture.alerts[0] ?? '', /Partial action: delete_message/u);
});

test('reports a protected member deletion failure accurately', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls, {
    deleteError: new Error('Temporary Discord failure'),
    protectedMember: true,
  });
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');

  assert.deepEqual(calls, [
    `delete:${MESSAGE_ID}`,
    `alert:${ALERT_CHANNEL_ID}`,
  ]);
  assert.match(
    fixture.alerts[0] ?? '',
    /Deletion failed; protected member roles unchanged; review required/u,
  );
});

function createConfig(): GatewayScamModerationConfig {
  return {
    alertChannelId: ALERT_CHANNEL_ID,
    enabled: true,
    excludedChannelIds: new Set(),
    guildId: GUILD_ID,
    protectedRoleIds: new Set(),
    restrictedRoleId: SCAM_ROLE_ID,
    verifiedRoleId: VERIFIED_ROLE_ID,
  };
}

function createDiscordFixture(
  calls: string[],
  options: {
    deleteError?: unknown;
    protectedMember?: boolean;
    restrictedPermissions?: bigint;
  } = {},
) {
  const alerts: string[] = [];
  const announcements: Array<{
    allowedMentions: { parse: string[] };
    content: string;
  }> = [];
  const restrictedRole = {
    id: SCAM_ROLE_ID,
    managed: false,
    permissions: { bitfield: options.restrictedPermissions ?? 0n },
    position: 5,
  };
  const verifiedRole = {
    id: VERIFIED_ROLE_ID,
    managed: false,
    permissions: { bitfield: 0n },
    position: 33,
  };
  const member = {
    id: USER_ID,
    joinedTimestamp: Date.now() - 90 * 24 * 60 * 60 * 1_000,
    permissions: { has: () => options.protectedMember ?? false },
    roles: {
      add: async (roleId: string) => {
        calls.push(`add:${roleId}`);
      },
      cache: new Map([[VERIFIED_ROLE_ID, verifiedRole]]),
      remove: async (roleId: string) => {
        calls.push(`remove:${roleId}`);
      },
    },
  };
  const guild = {
    members: {
      fetch: async () => member,
      fetchMe: async () => ({
        permissions: { has: () => true },
        roles: { highest: { position: 60 } },
      }),
    },
    roles: {
      fetch: async (roleId: string) =>
        roleId === SCAM_ROLE_ID ? restrictedRole : verifiedRole,
    },
  };
  const client = {
    channels: {
      fetch: async (channelId: string) => ({
        isSendable: () => true,
        send: async (payload: {
          allowedMentions: { parse: string[] };
          content: string;
        }) => {
          if (channelId === ALERT_CHANNEL_ID) {
            calls.push(`alert:${channelId}`);
            alerts.push(payload.content);
            return;
          }

          calls.push(`announce:${channelId}`);
          announcements.push(payload);
        },
      }),
    },
    guilds: { fetch: async () => guild },
  } as unknown as Client;
  const message = {
    author: {
      bot: false,
      createdTimestamp: Date.now() - 365 * 24 * 60 * 60 * 1_000,
      id: USER_ID,
    },
    channelId: CHANNEL_ID,
    content:
      '@everyone Giving out my MacBook and Canon camera for free. First come first serve. DM if interested on WhatsApp +1 (346) 383-3280.',
    delete: async () => {
      calls.push(`delete:${MESSAGE_ID}`);
      if (options.deleteError) {
        throw options.deleteError;
      }
    },
    guild,
    guildId: GUILD_ID,
    id: MESSAGE_ID,
    member,
    mentions: { everyone: true },
    partial: false,
    system: false,
    webhookId: null,
  } as unknown as Message;

  return { alerts, announcements, client, message };
}

function createLogger(errorMessages: string[] = []): Logger {
  return {
    debug: () => undefined,
    error: (message) => {
      errorMessages.push(message);
    },
    info: () => undefined,
    warn: () => undefined,
  };
}
