import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeScamMessage,
  normalizeScamText,
} from './scamDetectionPolicy.js';

const NOW = Date.UTC(2026, 7, 7, 22, 19, 0);
const OLD_ACCOUNT = NOW - 365 * 24 * 60 * 60 * 1_000;
const ESTABLISHED_MEMBER = NOW - 90 * 24 * 60 * 60 * 1_000;

test('flags the supplied MacBook giveaway scam with independent reasons', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      '@everyone I want to give out my MacBook Air 2022 & Charger for free, it is in perfect health and good as new. I just got a new model and thought of giving the old one to someone who cannot afford one. Strictly first come first serve! DM IF YOU ARE INTERESTED. WhatsApp: +1 (346) 383-3280',
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: true,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, true);
  assert.deepEqual(
    new Set(result.signalIds),
    new Set([
      'broadcast_mention',
      'direct_contact',
      'giveaway_lure',
      'high_value_item',
      'off_platform_contact',
      'phone_number',
      'replacement_story',
      'urgency',
    ]),
  );
});

test('flags camera and lens scams without treating camera words as suspicious alone', () => {
  const scam = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      '@everyone Giving away my Canon EOS R5 camera and lenses for free because I upgraded. First come, first served. Message me on Whats App at +1 765 555 0198.',
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: true,
    observedAtTimestamp: NOW,
  });
  const discussion = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      'Does anyone have experience with the Canon EOS R5, Sony a7 IV, or Nikon Z8? I need a camera and lens recommendation.',
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(scam.isLikelyScam, true);
  assert.ok(scam.signalIds.includes('high_value_item'));
  assert.equal(discussion.isLikelyScam, false);
  assert.deepEqual(discussion.signalIds, ['high_value_item']);
});

test('flags camera donation stories that move the recipient to WhatsApp', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      "I am donating my Sony A7 IV camera free of charge because I upgraded. Contact me on WhatsApp if you can't afford one: +1 765 555 0198.",
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, true);
  assert.ok(result.signalIds.includes('giveaway_lure'));
  assert.ok(result.signalIds.includes('high_value_item'));
});

test('normalizes full-width text, zero-width characters, confusables, and separated contact phrases', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      '@ｅveryone g\u200biving away an iＰｈｏｎｅ and cаmera for f r e e. fіrst—come first—serve. D.M. if interested. Whаts App: ＋１（３４６）３８３－３２８０',
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: true,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, true);
  assert.ok(result.signalIds.includes('off_platform_contact'));
  assert.ok(result.signalIds.includes('phone_number'));
});

test('keeps common legitimate photography and electronics messages below the action gate', () => {
  const legitimateMessages = [
    'Apple gave me a free MacBook for school.',
    'Does anyone use WhatsApp on a MacBook?',
    'Selling my MacBook Air for $500; DM me if you want photos.',
    "First come, first served: free club stickers at tonight's meeting.",
    'Call me at +1 (765) 555-0198 when you arrive.',
    'The camera checkout desk has free lens cloths for members.',
    'Scam warning: do not DM this person. They claim to be giving away a camera in exchange for a shipping fee.',
  ];

  for (const content of legitimateMessages) {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: false,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, false, content);
  }
});

test('uses account and server age only as modifiers for an already suspicious offer', () => {
  const content =
    'Giving away a Nikon Z8 camera. DM me if interested in getting it for free.';
  const established = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });
  const newcomer = analyzeScamMessage({
    accountCreatedTimestamp: NOW - 2 * 24 * 60 * 60 * 1_000,
    content,
    joinedTimestamp: NOW - 5 * 60 * 1_000,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });
  const harmlessNewcomer = analyzeScamMessage({
    accountCreatedTimestamp: NOW - 2 * 24 * 60 * 60 * 1_000,
    content: 'Hi, I am new here and use a Fujifilm camera.',
    joinedTimestamp: NOW - 5 * 60 * 1_000,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(established.isLikelyScam, false);
  assert.equal(newcomer.isLikelyScam, true);
  assert.equal(harmlessNewcomer.isLikelyScam, false);
});

test('bounds normalization work for adversarial message content', () => {
  const startedAt = performance.now();
  const normalized = normalizeScamText(
    `${'＠ｅｖｅｒｙｏｎｅ—\u200b'.repeat(1_000)}WhatsApp`,
  );
  const elapsedMs = performance.now() - startedAt;

  assert.ok(normalized.length <= 4_000);
  assert.ok(elapsedMs < 100);
});
