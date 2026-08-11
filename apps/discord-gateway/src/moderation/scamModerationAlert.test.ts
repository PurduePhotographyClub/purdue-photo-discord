import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ButtonStyle } from 'discord.js';
import {
  buildScamModerationAlertPayload,
  parseScamReviewAction,
} from './scamModerationAlert.js';

const GUILD_ID = '1182061172309106708';
const CHANNEL_ID = '1182061172309106709';
const MESSAGE_ID = '1535080862603808808';
const USER_ID = '1351727646211313784';

test('builds a complete evidence embed for a probable scam', () => {
  const payload = buildScamModerationAlertPayload({
    channelId: CHANNEL_ID,
    content:
      '@everyone Giving away my Canon camera. DM me on WhatsApp +1 (202) 555-0109.',
    eventType: 'MESSAGE_CREATE',
    failedActions: [],
    guildId: GUILD_ID,
    messageId: MESSAGE_ID,
    protectedMember: false,
    reviewOnly: false,
    reviewReason: 'suspicious_offer',
    score: 20,
    signalIds: [
      'direct_contact',
      'giveaway_lure',
      'high_value_item',
      'camera_giveaway_fingerprint',
    ],
    userId: USER_ID,
  });

  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.components.length, 0);
  assert.equal(payload.embeds.length, 1);

  const embed = payload.embeds[0]?.toJSON();
  assert.equal(embed?.title, 'Probable giveaway scam detected');
  assert.match(embed?.description ?? '', /Giving away my Canon camera/u);
  assert.match(embed?.description ?? '', /everyone/u);
  assert.doesNotMatch(embed?.description ?? '', /@everyone/u);
  assertField(embed?.fields, 'User', `<@${USER_ID}>`);
  assertField(embed?.fields, 'User', USER_ID);
  assertField(embed?.fields, 'Channel', `<#${CHANNEL_ID}>`);
  assertField(embed?.fields, 'Channel', CHANNEL_ID);
  assertField(
    embed?.fields,
    'Message',
    `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`,
  );
  assertField(embed?.fields, 'Message', MESSAGE_ID);
  assertField(embed?.fields, 'Event', 'MESSAGE_CREATE');
  assertField(embed?.fields, 'Score', '20');
  assertField(embed?.fields, 'Signals', 'camera_giveaway_fingerprint');
  assertField(
    embed?.fields,
    'Result',
    'Message deleted; verified removed when present; Clown added.',
  );
});

test('adds Confirm scam and Dismiss controls to an actionable review', () => {
  const payload = buildScamModerationAlertPayload({
    channelId: CHANNEL_ID,
    content: 'Selling two concert tickets. Message me if interested.',
    eventType: 'MESSAGE_CREATE',
    failedActions: [],
    guildId: GUILD_ID,
    messageId: MESSAGE_ID,
    protectedMember: false,
    reviewOnly: true,
    reviewReason: 'suspicious_offer',
    score: 10,
    signalIds: ['direct_contact', 'ticket_offer'],
    userId: USER_ID,
  });

  const embed = payload.embeds[0]?.toJSON();
  assert.equal(embed?.title, 'Possible scam needs review');
  assertField(embed?.fields, 'Result', 'No action taken yet.');

  const rows = payload.components.map((row) => row.toJSON());
  const buttons = (rows[0]?.components ?? []) as Array<{
    custom_id?: string;
    label?: string;
    style: number;
  }>;
  assert.equal(buttons.length, 2);
  assert.deepEqual(
    buttons.map((button) => button.label),
    ['Confirm scam', 'Dismiss'],
  );
  assert.deepEqual(
    buttons.map((button) => button.style),
    [ButtonStyle.Danger, ButtonStyle.Secondary],
  );
  for (const button of buttons) {
    assert.ok((button.custom_id?.length ?? 101) <= 100);
  }
});

test('does not offer a destructive action against someone reporting a scam', () => {
  const payload = buildScamModerationAlertPayload({
    channelId: CHANNEL_ID,
    content: 'Is this a scam? Someone sent me this: Giving away a camera.',
    eventType: 'MESSAGE_CREATE',
    failedActions: [],
    guildId: GUILD_ID,
    messageId: MESSAGE_ID,
    protectedMember: false,
    reviewOnly: true,
    reviewReason: 'reported_scam',
    score: 18,
    signalIds: ['giveaway_lure', 'high_value_item'],
    userId: USER_ID,
  });

  const buttons = (payload.components[0]?.toJSON().components ?? []) as Array<{
    label?: string;
  }>;
  assert.deepEqual(
    buttons.map((button) => button.label),
    ['Mark reviewed'],
  );
  assert.equal(
    buttons.some((button) => button.label === 'Confirm scam'),
    false,
  );
});

test('truncates long evidence safely and parses only valid review controls', () => {
  const payload = buildScamModerationAlertPayload({
    channelId: CHANNEL_ID,
    content: `\`\`\`\n@everyone\n${'camera '.repeat(1_000)}`,
    eventType: 'MESSAGE_UPDATE',
    failedActions: [],
    guildId: GUILD_ID,
    messageId: MESSAGE_ID,
    protectedMember: false,
    reviewOnly: true,
    reviewReason: 'suspicious_offer',
    score: 11,
    signalIds: ['giveaway_lure'],
    userId: USER_ID,
  });

  const description = payload.embeds[0]?.toJSON().description ?? '';
  assert.ok(description.length <= 4_096);
  assert.match(description, /everyone/u);
  assert.doesNotMatch(description, /@everyone/u);
  assert.match(description, /…$/u);

  assert.deepEqual(parseScamReviewAction(`scam-review:confirm:${MESSAGE_ID}`), {
    action: 'confirm',
    reviewId: MESSAGE_ID,
  });
  assert.deepEqual(parseScamReviewAction(`scam-review:dismiss:${MESSAGE_ID}`), {
    action: 'dismiss',
    reviewId: MESSAGE_ID,
  });
  assert.equal(
    parseScamReviewAction('scam-review:confirm:not-a-snowflake'),
    null,
  );
  assert.equal(parseScamReviewAction(`other:confirm:${MESSAGE_ID}`), null);
});

test('renders attacker-controlled markdown and links as inert evidence', () => {
  const payload = buildScamModerationAlertPayload({
    channelId: CHANNEL_ID,
    content:
      '[Free camera](https://evil.example/path) **@everyone** ``` <@1063962284386439199>',
    eventType: 'MESSAGE_CREATE',
    failedActions: [],
    guildId: GUILD_ID,
    messageId: MESSAGE_ID,
    protectedMember: false,
    reviewOnly: true,
    reviewReason: 'suspicious_offer',
    score: 10,
    signalIds: ['giveaway_lure'],
    userId: USER_ID,
  });

  const description = payload.embeds[0]?.toJSON().description ?? '';
  assert.doesNotMatch(description, /https:\/\//u);
  assert.doesNotMatch(description, /@everyone/u);
  assert.doesNotMatch(description, /\[Free camera\]\(/u);
  assert.match(description, /hxxps:\/\/evil\\\[\.\\\]example/u);
  assert.match(description, /\\<@1063962284386439199\\>/u);
});

function assertField(
  fields: readonly { name: string; value: string }[] | undefined,
  name: string,
  expectedValue: string,
) {
  const field = fields?.find((candidate) => candidate.name === name);
  assert.ok(field, `Missing ${name} field`);
  assert.match(field.value, new RegExp(escapeRegExp(expectedValue), 'u'));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
