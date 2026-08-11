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
const ALERT_MESSAGE_ID = '1536065199889584209';
const MODERATOR_ID = '1063962284386439199';
const ADMIN_ROLE_ID = '1364457359061155870';
const REPORTED_TICKET_TEMPLATE = `Is this a scam? Someone sent me this:

I have 4 amazing tickets for the Bruno Mars concert on Wed, Sep 9, 2026 at 7:00 PM at Lucas Oil Stadium.
Unfortunately, I’m no longer able to attend, so I’m looking to sell the tickets to someone who can truly enjoy the show.
You can take all 4 or just a pair.
Message me if you’re interested: +1 (202) 555-0112`;
const FACE_VALUE_COMPOUND_TICKET_SALE =
  'I have two amazing Bruno Mars tickets because I am no longer able to attend, and I am looking for someone who can truly enjoy the show. You can take both or a pair. I am selling them for the $125 face value printed on my receipt. DM me here or call +1 (202) 555-0117 if you want them.';
const WARNING_PREFIXED_TICKET_OFFER =
  'Scam warning: Someone is selling four Bruno Mars tickets because they can no longer attend. They said to take all four or a pair and DM or call +1 (202) 555-0118.';

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
  const alertText = getPayloadText(fixture.alerts[0]);
  assert.match(alertText, /Probable giveaway scam detected/u);
  assert.match(alertText, /MacBook|WhatsApp|555-0109/u);
  assert.deepEqual(fixture.alerts[0]?.allowedMentions, { parse: [] });
});

test('sends review-only ticket messages to the private alert without quarantine', async () => {
  for (const content of [
    REPORTED_TICKET_TEMPLATE,
    FACE_VALUE_COMPOUND_TICKET_SALE,
    WARNING_PREFIXED_TICKET_OFFER,
  ]) {
    const calls: string[] = [];
    const fixture = createDiscordFixture(calls, {
      content,
      mentionsEveryone: false,
    });
    const moderator = createDiscordScamModerator(
      createConfig(),
      createLogger(),
    );

    await moderator.initialize(fixture.client);
    await moderator.handle(fixture.message, 'MESSAGE_CREATE');

    assert.deepEqual(calls, [`alert:${ALERT_CHANNEL_ID}`], content);
    assert.equal(moderator.getHealth().handledCount, 1);
    const alertText = getPayloadText(fixture.alerts[0]);
    assert.match(alertText, /review/u);
    assert.doesNotMatch(alertText, /message deleted|clown added/u);
  }
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
  assert.match(
    getPayloadText(fixture.alerts[0]),
    /Partial action: delete_message/u,
  );
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
    getPayloadText(fixture.alerts[0]),
    /Deletion failed; protected member roles unchanged; manual follow-up required/u,
  );
});

test('lets an authorized moderator confirm an actionable review exactly once', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls, {
    content: FACE_VALUE_COMPOUND_TICKET_SALE,
    mentionsEveryone: false,
  });
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');
  const first = await moderator.review({
    action: 'confirm',
    actorId: MODERATOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: MESSAGE_ID,
  });
  const duplicate = await moderator.review({
    action: 'confirm',
    actorId: MODERATOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: MESSAGE_ID,
  });

  assert.equal(first.status, 'confirmed');
  assert.equal(duplicate.status, 'already_resolved');
  assert.deepEqual(calls, [
    `alert:${ALERT_CHANNEL_ID}`,
    `delete:${MESSAGE_ID}`,
    `add:${SCAM_ROLE_ID}`,
    `remove:${VERIFIED_ROLE_ID}`,
    `announce:${CHANNEL_ID}`,
  ]);
  assert.equal(fixture.alertEdits.length, 1);
  assert.match(
    getPayloadText(fixture.alertEdits[0]),
    /Scam confirmed by moderator/u,
  );
  assert.deepEqual(fixture.alertEdits[0]?.components, []);
});

test('allows only one winner when two moderators resolve the same review concurrently', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls, {
    content: FACE_VALUE_COMPOUND_TICKET_SALE,
    mentionsEveryone: false,
  });
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');
  const request = {
    action: 'confirm' as const,
    actorId: MODERATOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: MESSAGE_ID,
  };
  const results = await Promise.all([
    moderator.review(request),
    moderator.review(request),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), [
    'already_resolved',
    'confirmed',
  ]);
  assert.equal(calls.filter((call) => call.startsWith('delete:')).length, 1);
  assert.equal(calls.filter((call) => call.startsWith('add:')).length, 1);
  assert.equal(calls.filter((call) => call.startsWith('announce:')).length, 1);
});

test('releases a review claim after a transient confirmation failure', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls, {
    content: FACE_VALUE_COMPOUND_TICKET_SALE,
    mentionsEveryone: false,
    sourceChannelFetchErrorOnce: new Error('Temporary Discord outage'),
  });
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');
  const request = {
    action: 'confirm' as const,
    actorId: MODERATOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: MESSAGE_ID,
  };
  const first = await moderator.review(request);
  const retry = await moderator.review(request);

  assert.equal(first.status, 'unavailable');
  assert.equal(retry.status, 'confirmed');
  assert.equal(calls.filter((call) => call.startsWith('delete:')).length, 1);
});

test('invalidates confirmation when the reviewed message content changed', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls, {
    content: FACE_VALUE_COMPOUND_TICKET_SALE,
    mentionsEveryone: false,
  });
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');
  (fixture.message as unknown as { content: string }).content =
    `Scam warning: ${FACE_VALUE_COMPOUND_TICKET_SALE}`;
  const result = await moderator.review({
    action: 'confirm',
    actorId: MODERATOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: MESSAGE_ID,
  });

  assert.equal(result.status, 'message_changed');
  assert.deepEqual(calls, [`alert:${ALERT_CHANNEL_ID}`]);
  assert.match(getPayloadText(fixture.alertEdits[0]), /could not be applied/u);
});

test('attempts Clown and verified role changes independently after confirmation', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls, {
    addRoleError: new Error('Could not add Clown'),
    content: FACE_VALUE_COMPOUND_TICKET_SALE,
    mentionsEveryone: false,
    removeRoleError: new Error('Could not remove verified'),
  });
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');
  const result = await moderator.review({
    action: 'confirm',
    actorId: MODERATOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: MESSAGE_ID,
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(calls.includes(`add:${SCAM_ROLE_ID}`), true);
  assert.equal(calls.includes(`remove:${VERIFIED_ROLE_ID}`), true);
  assert.match(result.message, /Clown role/u);
  assert.match(result.message, /verified role/u);
});

test('dismisses a review without touching the source message or member roles', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls, {
    content: FACE_VALUE_COMPOUND_TICKET_SALE,
    mentionsEveryone: false,
  });
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');
  const result = await moderator.review({
    action: 'dismiss',
    actorId: MODERATOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: MESSAGE_ID,
  });

  assert.equal(result.status, 'dismissed');
  assert.deepEqual(calls, [`alert:${ALERT_CHANNEL_ID}`]);
  assert.match(getPayloadText(fixture.alertEdits[0]), /Scam review dismissed/u);
});

test('rechecks moderator authorization on the Gateway before resolving', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls, {
    content: FACE_VALUE_COMPOUND_TICKET_SALE,
    mentionsEveryone: false,
    moderatorAuthorized: false,
  });
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');
  const result = await moderator.review({
    action: 'confirm',
    actorId: MODERATOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: MESSAGE_ID,
  });

  assert.equal(result.status, 'forbidden');
  assert.deepEqual(calls, [`alert:${ALERT_CHANNEL_ID}`]);
  assert.equal(fixture.alertEdits.length, 0);
});

test('does not let a review button punish a scam reporter', async () => {
  const calls: string[] = [];
  const fixture = createDiscordFixture(calls, {
    content: REPORTED_TICKET_TEMPLATE,
    mentionsEveryone: false,
  });
  const moderator = createDiscordScamModerator(createConfig(), createLogger());

  await moderator.initialize(fixture.client);
  await moderator.handle(fixture.message, 'MESSAGE_CREATE');
  const forbidden = await moderator.review({
    action: 'confirm',
    actorId: MODERATOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: MESSAGE_ID,
  });
  const reviewed = await moderator.review({
    action: 'reviewed',
    actorId: MODERATOR_ID,
    alertMessageId: ALERT_MESSAGE_ID,
    reviewId: MESSAGE_ID,
  });

  assert.equal(forbidden.status, 'forbidden');
  assert.equal(reviewed.status, 'reviewed');
  assert.deepEqual(calls, [`alert:${ALERT_CHANNEL_ID}`]);
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
    addRoleError?: Error;
    content?: string;
    deleteError?: unknown;
    mentionsEveryone?: boolean;
    moderatorAuthorized?: boolean;
    protectedMember?: boolean;
    removeRoleError?: Error;
    restrictedPermissions?: bigint;
    sourceChannelFetchErrorOnce?: Error;
  } = {},
) {
  const alerts: DiscordPayload[] = [];
  const alertEdits: DiscordPayload[] = [];
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
        if (options.addRoleError) {
          throw options.addRoleError;
        }
      },
      cache: new Map([[VERIFIED_ROLE_ID, verifiedRole]]),
      remove: async (roleId: string) => {
        calls.push(`remove:${roleId}`);
        if (options.removeRoleError) {
          throw options.removeRoleError;
        }
      },
    },
  };
  const moderatorMember = {
    id: MODERATOR_ID,
    permissions: { has: () => options.moderatorAuthorized ?? true },
    roles: {
      cache: new Map(
        options.moderatorAuthorized === false
          ? []
          : [[ADMIN_ROLE_ID, { id: ADMIN_ROLE_ID }]],
      ),
    },
  };
  const guild = {
    members: {
      fetch: async (userId?: string) =>
        userId === MODERATOR_ID ? moderatorMember : member,
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
  let sourceChannelFetchAttempts = 0;
  const client = {
    channels: {
      fetch: async (channelId: string) => {
        if (channelId === CHANNEL_ID) {
          sourceChannelFetchAttempts += 1;
          if (
            sourceChannelFetchAttempts === 1 &&
            options.sourceChannelFetchErrorOnce
          ) {
            throw options.sourceChannelFetchErrorOnce;
          }
        }
        return {
          isSendable: () => true,
          isTextBased: () => true,
          messages: {
            fetch: async (messageId: string) => {
              if (channelId === ALERT_CHANNEL_ID) {
                assert.equal(messageId, ALERT_MESSAGE_ID);
                return {
                  edit: async (payload: DiscordPayload) => {
                    alertEdits.push(payload);
                  },
                };
              }
              assert.equal(messageId, MESSAGE_ID);
              return message;
            },
          },
          send: async (payload: DiscordPayload) => {
            if (channelId === ALERT_CHANNEL_ID) {
              calls.push(`alert:${channelId}`);
              alerts.push(payload);
              return { id: ALERT_MESSAGE_ID };
            }

            calls.push(`announce:${channelId}`);
            announcements.push(payload as (typeof announcements)[number]);
            return { id: '1536065199889584210' };
          },
        };
      },
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
      options.content ??
      '@everyone Giving out my MacBook and Canon camera for free. First come first serve. DM if interested on WhatsApp +1 (202) 555-0109.',
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
    mentions: { everyone: options.mentionsEveryone ?? true },
    partial: false,
    system: false,
    webhookId: null,
  } as unknown as Message;

  return { alertEdits, alerts, announcements, client, message };
}

interface DiscordPayload {
  allowedMentions?: { parse: string[] };
  components?: unknown[];
  content?: string;
  embeds?: Array<{ toJSON(): unknown }>;
}

function getPayloadText(payload: DiscordPayload | undefined) {
  if (!payload) {
    return '';
  }
  return JSON.stringify({
    ...payload,
    embeds: payload.embeds?.map((embed) => embed.toJSON()),
  });
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
