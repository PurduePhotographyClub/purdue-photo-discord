import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createScamModerationService,
  type ScamMessageContext,
  type ScamModerationActions,
} from './scamModerationService.js';

const GUILD_ID = '1182061172309106708';
const CHANNEL_ID = '1182061172309106709';
const MESSAGE_ID = '1535080862603808808';
const USER_ID = '1351727646211313784';
const SCAM_ROLE_ID = '1515784633374212247';
const VERIFIED_ROLE_ID = '1503180707550199920';
const ALERT_CHANNEL_ID = '1232870129000386620';
const NOW = Date.UTC(2026, 7, 7, 22, 19, 0);

test('deletes the supplied scam, removes verified, adds Clown, and alerts moderators', async () => {
  const calls: string[] = [];
  const service = createService();

  const result = await service.moderate(createMessage(), createActions(calls));

  assert.equal(result.handled, true);
  assert.equal(result.duplicate, false);
  assert.deepEqual(calls, [
    `delete:${CHANNEL_ID}:${MESSAGE_ID}`,
    `remove:${GUILD_ID}:${USER_ID}:${VERIFIED_ROLE_ID}`,
    `add:${GUILD_ID}:${USER_ID}:${SCAM_ROLE_ID}`,
    `alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
  assert.deepEqual(result.failedActions, []);
});

test('quarantines edited scams and deduplicates repeated events by message ID', async () => {
  const calls: string[] = [];
  const service = createService();
  const editedMessage = createMessage({ eventType: 'MESSAGE_UPDATE' });

  const first = await service.moderate(editedMessage, createActions(calls));
  const duplicate = await service.moderate(editedMessage, createActions(calls));

  assert.equal(first.handled, true);
  assert.equal(duplicate.handled, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls.filter((call) => call.startsWith('alert:')).length, 1);
  assert.equal(calls.filter((call) => call.startsWith('delete:')).length, 1);
});

test('does not moderate bots, webhooks, system messages, DMs, other guilds, or excluded channels', async () => {
  const ignoredMessages = [
    createMessage({ authorBot: true }),
    createMessage({ webhookId: 'webhook-123' }),
    createMessage({ system: true }),
    createMessage({ guildId: null }),
    createMessage({ guildId: '999999999999999999' }),
    createMessage({ channelId: ALERT_CHANNEL_ID }),
    createMessage({ content: 'I like cameras.' }),
  ];

  for (const message of ignoredMessages) {
    const calls: string[] = [];
    const result = await createService().moderate(
      message,
      createActions(calls),
    );

    assert.equal(result.handled, false);
    assert.deepEqual(calls, []);
  }
});

test('deletes protected staff scams but leaves staff roles unchanged', async () => {
  const calls: string[] = [];
  const result = await createService().moderate(
    createMessage({ protectedMember: true }),
    createActions(calls),
  );

  assert.equal(result.handled, true);
  assert.equal(result.protectedMember, true);
  assert.deepEqual(calls, [
    `delete:${CHANNEL_ID}:${MESSAGE_ID}`,
    `alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
});

test('does not remove verified when the member does not have it', async () => {
  const calls: string[] = [];
  const result = await createService().moderate(
    createMessage({ roleIds: [] }),
    createActions(calls),
  );

  assert.equal(result.handled, true);
  assert.deepEqual(calls, [
    `delete:${CHANNEL_ID}:${MESSAGE_ID}`,
    `add:${GUILD_ID}:${USER_ID}:${SCAM_ROLE_ID}`,
    `alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
});

test('attempts every independent action and reports partial failures', async () => {
  const calls: string[] = [];
  const actions = createActions(calls, {
    addRestrictedRole: new Error('Missing permissions'),
    deleteMessage: new Error('Unknown message'),
  });

  const result = await createService().moderate(createMessage(), actions);

  assert.equal(result.handled, true);
  assert.deepEqual(calls, [
    `delete:${CHANNEL_ID}:${MESSAGE_ID}`,
    `remove:${GUILD_ID}:${USER_ID}:${VERIFIED_ROLE_ID}`,
    `add:${GUILD_ID}:${USER_ID}:${SCAM_ROLE_ID}`,
    `alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
  assert.deepEqual(result.failedActions, [
    'delete_message',
    'add_restricted_role',
  ]);
});

function createService() {
  return createScamModerationService({
    alertChannelId: ALERT_CHANNEL_ID,
    enabled: true,
    excludedChannelIds: new Set([ALERT_CHANNEL_ID]),
    guildId: GUILD_ID,
    restrictedRoleId: SCAM_ROLE_ID,
    verifiedRoleId: VERIFIED_ROLE_ID,
  });
}

function createMessage(
  overrides: Partial<ScamMessageContext> & {
    authorBot?: boolean;
    protectedMember?: boolean;
  } = {},
): ScamMessageContext {
  const {
    authorBot = false,
    protectedMember = false,
    ...messageOverrides
  } = overrides;

  return {
    accountCreatedTimestamp: NOW - 365 * 24 * 60 * 60 * 1_000,
    authorBot,
    channelId: CHANNEL_ID,
    content:
      '@everyone Giving out my MacBook and Canon camera for free. First come first serve. DM if interested on WhatsApp +1 (346) 383-3280.',
    eventType: 'MESSAGE_CREATE',
    guildId: GUILD_ID,
    joinedTimestamp: NOW - 90 * 24 * 60 * 60 * 1_000,
    mentionsEveryone: true,
    messageId: MESSAGE_ID,
    observedAtTimestamp: NOW,
    protectedMember,
    roleIds: [VERIFIED_ROLE_ID],
    system: false,
    userId: USER_ID,
    webhookId: null,
    ...messageOverrides,
  };
}

function createActions(
  calls: string[],
  failures: Partial<Record<keyof ScamModerationActions, Error>> = {},
): ScamModerationActions {
  return {
    addRestrictedRole: async (guildId, userId, roleId) => {
      calls.push(`add:${guildId}:${userId}:${roleId}`);
      throwIfConfigured(failures.addRestrictedRole);
    },
    deleteMessage: async (channelId, messageId) => {
      calls.push(`delete:${channelId}:${messageId}`);
      throwIfConfigured(failures.deleteMessage);
    },
    removeVerifiedRole: async (guildId, userId, roleId) => {
      calls.push(`remove:${guildId}:${userId}:${roleId}`);
      throwIfConfigured(failures.removeVerifiedRole);
    },
    sendAlert: async (alertChannelId, alert) => {
      calls.push(`alert:${alertChannelId}:${alert.messageId}`);
      throwIfConfigured(failures.sendAlert);
    },
  };
}

function throwIfConfigured(error: Error | undefined) {
  if (error) {
    throw error;
  }
}
