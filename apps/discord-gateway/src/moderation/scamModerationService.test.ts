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
const PUBLIC_ANNOUNCEMENT_COPY = '🚨 Likely scam removed. Nice try. 🤡';
const REPORTED_TICKET_TEMPLATE = `Is this a scam? Someone sent me this:

I have 4 amazing tickets for the Bruno Mars concert on Wed, Sep 9, 2026 at 7:00 PM at Lucas Oil Stadium.
Unfortunately, I’m no longer able to attend, so I’m looking to sell the tickets to someone who can truly enjoy the show.
You can take all 4 or just a pair.
Message me if you’re interested: +1 (202) 555-0110`;
const FACE_VALUE_COMPOUND_TICKET_SALE =
  'I have two amazing Bruno Mars tickets because I am no longer able to attend, and I am looking for someone who can truly enjoy the show. You can take both or a pair. I am selling them for the $125 face value printed on my receipt. DM me here or call +1 (202) 555-0115 if you want them.';
const WARNING_PREFIXED_TICKET_OFFER =
  'Scam warning: Someone is selling four Bruno Mars tickets because they can no longer attend. They said to take all four or a pair and DM or call +1 (202) 555-0116.';

interface PublicAnnouncementCall {
  channelId: string;
  content: string;
}

type ScamModerationActionsWithAnnouncement = ScamModerationActions & {
  sendPublicAnnouncement: (channelId: string, content: string) => Promise<void>;
};

test('deletes the supplied scam, posts the generic public announcement, removes verified, adds Clown, and alerts moderators', async () => {
  const calls: string[] = [];
  const announcements: PublicAnnouncementCall[] = [];
  const service = createService();

  const message = createMessage();
  const result = await service.moderate(
    message,
    createActions(calls, {}, announcements),
  );

  assert.equal(result.handled, true);
  assert.equal(result.duplicate, false);
  assert.deepEqual(calls, [
    `delete:${CHANNEL_ID}:${MESSAGE_ID}`,
    `remove:${GUILD_ID}:${USER_ID}:${VERIFIED_ROLE_ID}`,
    `add:${GUILD_ID}:${USER_ID}:${SCAM_ROLE_ID}`,
    `announce:${CHANNEL_ID}`,
    `alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
  assert.deepEqual(announcements, [
    {
      channelId: CHANNEL_ID,
      content: PUBLIC_ANNOUNCEMENT_COPY,
    },
  ]);
  assert.equal(PUBLIC_ANNOUNCEMENT_COPY.includes(USER_ID), false);
  assert.equal(PUBLIC_ANNOUNCEMENT_COPY.includes(MESSAGE_ID), false);
  assert.equal(PUBLIC_ANNOUNCEMENT_COPY.includes(message.content), false);
  assert.doesNotMatch(PUBLIC_ANNOUNCEMENT_COPY, /@(?:everyone|here)|<@/i);
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
  assert.equal(calls.filter((call) => call.startsWith('announce:')).length, 1);
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

test('privately alerts on review-only scam reports and face-value ticket pitches without quarantine', async () => {
  const reviewOnlyMessages = [
    createMessage({
      content: REPORTED_TICKET_TEMPLATE,
      mentionsEveryone: false,
    }),
    createMessage({
      content:
        'Scam warning: @everyone Giving away my MacBook for free because I upgraded. First come first served. DM me on WhatsApp at +1 (202) 555-0111.',
    }),
    createMessage({
      content: FACE_VALUE_COMPOUND_TICKET_SALE,
      mentionsEveryone: false,
    }),
    createMessage({
      content: WARNING_PREFIXED_TICKET_OFFER,
      mentionsEveryone: false,
    }),
  ];

  for (const message of reviewOnlyMessages) {
    const calls: string[] = [];
    const result = await createService().moderate(
      message,
      createActions(calls),
    );

    assert.equal(result.handled, true);
    assert.equal(result.analysis?.isLikelyScam, false);
    assert.equal(result.analysis?.requiresReview, true);
    assert.deepEqual(calls, [`alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`]);
  }
});

test('retries review-only moderation when the private alert fails', async () => {
  const calls: string[] = [];
  let alertAttempts = 0;
  const baseActions = createActions(calls);
  const actions: ScamModerationActionsWithAnnouncement = {
    ...baseActions,
    sendAlert: async (alertChannelId, alert) => {
      alertAttempts += 1;
      calls.push(`alert:${alertChannelId}:${alert.messageId}`);
      if (alertAttempts === 1) {
        throw new Error('Temporary alert channel failure');
      }
    },
  };
  const service = createService();
  const reviewMessage = createMessage({
    content: REPORTED_TICKET_TEMPLATE,
    mentionsEveryone: false,
  });

  const first = await service.moderate(reviewMessage, actions);
  const retry = await service.moderate(
    {
      ...reviewMessage,
      eventType: 'MESSAGE_UPDATE',
      observedAtTimestamp: NOW + 1_000,
    },
    actions,
  );

  assert.deepEqual(first.failedActions, ['send_alert']);
  assert.equal(retry.duplicate, false);
  assert.deepEqual(retry.failedActions, []);
  assert.equal(alertAttempts, 2);
  assert.deepEqual(calls, [
    `alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`,
    `alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
});

test('deletes protected staff scams without a public callout or role changes', async () => {
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
    `announce:${CHANNEL_ID}`,
    `alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
});

test('waits for confirmed deletion before announcing in the deleted message channel', async () => {
  const calls: string[] = [];
  const announcements: PublicAnnouncementCall[] = [];
  let confirmDeletion: (() => void) | undefined;
  const deletionConfirmed = new Promise<void>((resolve) => {
    confirmDeletion = resolve;
  });
  const baseActions = createActions(calls, {}, announcements);
  const actions: ScamModerationActionsWithAnnouncement = {
    ...baseActions,
    deleteMessage: async (channelId, messageId) => {
      calls.push(`delete:${channelId}:${messageId}`);
      await deletionConfirmed;
    },
  };

  const moderation = createService().moderate(createMessage(), actions);

  assert.deepEqual(calls, [`delete:${CHANNEL_ID}:${MESSAGE_ID}`]);
  assert.deepEqual(announcements, []);

  assert.ok(confirmDeletion);
  confirmDeletion();
  await moderation;

  assert.deepEqual(announcements, [
    {
      channelId: CHANNEL_ID,
      content: PUBLIC_ANNOUNCEMENT_COPY,
    },
  ]);
});

test('announces when deletion reports that the scam message was already gone', async () => {
  const calls: string[] = [];
  const announcements: PublicAnnouncementCall[] = [];
  const baseActions = createActions(calls, {}, announcements);
  const actions: ScamModerationActionsWithAnnouncement = {
    ...baseActions,
    deleteMessage: async (channelId, messageId) => {
      calls.push(`delete-already-gone:${channelId}:${messageId}`);
    },
  };

  const result = await createService().moderate(createMessage(), actions);

  assert.equal(result.handled, true);
  assert.deepEqual(calls, [
    `delete-already-gone:${CHANNEL_ID}:${MESSAGE_ID}`,
    `remove:${GUILD_ID}:${USER_ID}:${VERIFIED_ROLE_ID}`,
    `add:${GUILD_ID}:${USER_ID}:${SCAM_ROLE_ID}`,
    `announce:${CHANNEL_ID}`,
    `alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
});

test('retries the same scam message after a transient deletion failure', async () => {
  const calls: string[] = [];
  let deletionAttempts = 0;
  const baseActions = createActions(calls);
  const actions: ScamModerationActionsWithAnnouncement = {
    ...baseActions,
    deleteMessage: async (channelId, messageId) => {
      deletionAttempts += 1;
      calls.push(`delete:${channelId}:${messageId}`);
      if (deletionAttempts === 1) {
        throw new Error('Temporary Discord failure');
      }
    },
  };
  const service = createService();

  const first = await service.moderate(createMessage(), actions);
  const retry = await service.moderate(createMessage(), actions);

  assert.equal(first.failedActions.includes('delete_message'), true);
  assert.equal(retry.duplicate, false);
  assert.equal(deletionAttempts, 2);
  assert.equal(calls.filter((call) => call.startsWith('announce:')).length, 1);
});

test('limits public announcements to one per channel every 30 seconds', async () => {
  const calls: string[] = [];
  const announcements: PublicAnnouncementCall[] = [];
  const service = createService();
  const actions = createActions(calls, {}, announcements);

  await service.moderate(createMessage(), actions);
  await service.moderate(
    createMessage({
      messageId: '1535080862603808809',
      observedAtTimestamp: NOW + 1_000,
      userId: '1351727646211313785',
    }),
    actions,
  );
  await service.moderate(
    createMessage({
      messageId: '1535080862603808810',
      observedAtTimestamp: NOW + 31_000,
      userId: '1351727646211313786',
    }),
    actions,
  );

  assert.equal(calls.filter((call) => call.startsWith('delete:')).length, 3);
  assert.equal(announcements.length, 2);
});

test('announcement failure does not prevent role actions or the moderator alert', async () => {
  const calls: string[] = [];
  const actions = createActions(calls, {
    sendPublicAnnouncement: new Error('Missing Send Messages permission'),
  });

  const result = await createService().moderate(createMessage(), actions);

  assert.equal(result.handled, true);
  assert.deepEqual(calls, [
    `delete:${CHANNEL_ID}:${MESSAGE_ID}`,
    `remove:${GUILD_ID}:${USER_ID}:${VERIFIED_ROLE_ID}`,
    `add:${GUILD_ID}:${USER_ID}:${SCAM_ROLE_ID}`,
    `announce:${CHANNEL_ID}`,
    `alert:${ALERT_CHANNEL_ID}:${MESSAGE_ID}`,
  ]);
  assert.deepEqual(result.failedActions, ['send_public_announcement']);
});

test('keeps the channel cooldown after a failed announcement attempt', async () => {
  const calls: string[] = [];
  const service = createService();
  const actions = createActions(calls, {
    sendPublicAnnouncement: new Error('Discord rate limited the send'),
  });

  await service.moderate(createMessage(), actions);
  await service.moderate(
    createMessage({
      messageId: '1535080862603808809',
      observedAtTimestamp: NOW + 1_000,
      userId: '1351727646211313785',
    }),
    actions,
  );

  assert.equal(calls.filter((call) => call.startsWith('delete:')).length, 2);
  assert.equal(calls.filter((call) => call.startsWith('announce:')).length, 1);
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
  assert.equal(
    calls.some((call) => call.startsWith('announce:')),
    false,
  );
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
      '@everyone Giving out my MacBook and Canon camera for free. First come first serve. DM if interested on WhatsApp +1 (202) 555-0109.',
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
  failures: Partial<
    Record<keyof ScamModerationActionsWithAnnouncement, Error>
  > = {},
  announcements: PublicAnnouncementCall[] = [],
): ScamModerationActionsWithAnnouncement {
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
    sendPublicAnnouncement: async (channelId, content) => {
      calls.push(`announce:${channelId}`);
      announcements.push({ channelId, content });
      throwIfConfigured(failures.sendPublicAnnouncement);
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
