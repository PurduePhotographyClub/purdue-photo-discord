import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeScamMessage,
  normalizeScamText,
  type ScamSignalId,
} from './scamDetectionPolicy.js';

const NOW = Date.UTC(2026, 7, 7, 22, 19, 0);
const OLD_ACCOUNT = NOW - 365 * 24 * 60 * 60 * 1_000;
const ESTABLISHED_MEMBER = NOW - 90 * 24 * 60 * 60 * 1_000;
const BRUNO_MARS_TICKET_SCAM = `I have 4 amazing tickets for the Bruno Mars concert on Wed , Sep 9, 2026 at 7:00 PM at Lucas oil  Stadium , Indianapolis , Indiana.

Unfortunately, I’m no longer able to attend, so I’m looking to sell the tickets to someone who can truly enjoy the show.
You can take all 4 or just a pair.
Message me if you’re interested: +1 (202) 555-0104`;
const NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM = [
  'Hi ',
  'I have 4 amazing for the Bruno Mars concert on Wed , Sep 9, 2026 at 7:00 PM at Lucas oil Stadium , Indianapolis , Indiana.',
  '',
  'Unfortunately, I’m no longer able to attend, so I’m looking to sell the to someone who can truly enjoy the show.',
  'You can take all 4 or just a pair.',
  'Message me if you’re interested: +1 (202) 555-0119',
].join('\n');
const NOUN_OMITTED_FACE_VALUE_TICKET_SALE =
  NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM.replace(
    'You can take all 4 or just a pair.',
    'You can take all 4 or just a pair at face value.',
  );
const COPIED_MESSAGE_PREFIXED_NOUN_OMITTED_TICKET_SCAM = `Heads up, this copied message is circulating:\n\n${NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM}`;
const GRAMMATICAL_NOUN_OMITTED_TICKET_SALE =
  NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM.replace(
    'looking to sell the to someone',
    'looking to sell to someone',
  );
const MESSAGE_ONLY_NOUN_OMITTED_TICKET_SALE =
  NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM.replace(
    'Message me if you’re interested: +1 (202) 555-0119',
    'Message me if you’re interested.',
  );
const PHONE_ONLY_NOUN_OMITTED_TICKET_SALE =
  NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM.replace(
    'Message me if you’re interested: +1 (202) 555-0119',
    '+1 (202) 555-0121',
  );
const BRUNO_MARS_TICKET_SCAM_SIGNALS = [
  'direct_contact',
  'phone_number',
  'ticket_bundle',
  'ticket_offer',
  'ticket_template_fingerprint',
  'unable_to_attend_story',
] as const satisfies readonly ScamSignalId[];
const FACE_VALUE_COMPOUND_TICKET_SALE =
  'I have two amazing Bruno Mars tickets because I am no longer able to attend, and I am looking for someone who can truly enjoy the show. You can take both or a pair. I am selling them for the $125 face value printed on my receipt. DM me here or call +1 (202) 555-0105 if you want them.';
const WARNING_PREFIXED_TICKET_OFFER =
  'Scam warning: Someone is selling four Bruno Mars tickets because they can no longer attend. They said to take all four or a pair and DM or call +1 (202) 555-0113.';

test('flags the supplied MacBook giveaway scam with independent reasons', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      '@everyone I want to give out my MacBook Air 2022 & Charger for free, it is in perfect health and good as new. I just got a new model and thought of giving the old one to someone who cannot afford one. Strictly first come first serve! DM IF YOU ARE INTERESTED. WhatsApp: +1 (202) 555-0101',
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

test('flags the copied Bruno Mars ticket pitch through a ticket-template fingerprint', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: BRUNO_MARS_TICKET_SCAM,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, true);
  assert.equal(result.requiresReview, false);
  assert.deepEqual(
    new Set(result.signalIds),
    new Set(BRUNO_MARS_TICKET_SCAM_SIGNALS),
  );
});

test('flags the supplied noun-omitted Bruno Mars pitch through the template fingerprint', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, true);
  assert.equal(result.requiresReview, false);
  assert.ok(result.signalIds.includes('ticket_template_fingerprint'));
});

test('sends the noun-omitted template with face value to review instead of quarantine', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: NOUN_OMITTED_FACE_VALUE_TICKET_SALE,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, false);
  assert.equal(result.requiresReview, true);
  assert.ok(result.signalIds.includes('ticket_template_fingerprint'));
});

test('routes a copied-message-prefixed noun-omitted pitch to review instead of quarantine', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: COPIED_MESSAGE_PREFIXED_NOUN_OMITTED_TICKET_SCAM,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, false);
  assert.equal(result.requiresReview, true);
  assert.ok(result.signalIds.includes('ticket_template_fingerprint'));
});

for (const { content, label } of [
  {
    content: GRAMMATICAL_NOUN_OMITTED_TICKET_SALE,
    label: 'grammatical sell to',
  },
  {
    content: MESSAGE_ONLY_NOUN_OMITTED_TICKET_SALE,
    label: 'Message me without a phone number',
  },
  {
    content: PHONE_ONLY_NOUN_OMITTED_TICKET_SALE,
    label: 'phone number without Message me',
  },
]) {
  test(`keeps the ${label} near match out of quarantine but requires review`, () => {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: false,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, false, label);
    assert.equal(result.requiresReview, true, label);
  });
}

test('does not quarantine detailed concert discussion or unrelated marketplace copy', () => {
  const legitimateMessages = [
    'The Bruno Mars concert is Wednesday, September 9, 2026 at 7:00 PM at Lucas Oil Stadium in Indianapolis, Indiana. Doors open at 5:30 PM. Does anyone know the camera policy?',
    'Who else is going to the Bruno Mars show at Lucas Oil Stadium? Four of us are meeting by the south entrance before the 7:00 PM start.',
    'I have four amazing framed prints for sale because my plans changed. I am looking to sell them to someone who can truly enjoy the art. You can take all four or just a pair. Message me at +1 (202) 555-0120.',
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
    assert.equal(result.requiresReview, false, content);
  }
});

test('keeps a face-value compound ticket pitch unquarantined but marks it for private review', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: FACE_VALUE_COMPOUND_TICKET_SALE,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, false);
  assert.equal(result.requiresReview, true);
});

test('routes copied and warning-prefixed scam text to review without quarantining the reporter', () => {
  const copiedPitch = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: `Is this a scam? Someone sent me this:\n\n${BRUNO_MARS_TICKET_SCAM}`,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });
  const warningPrefixedGiveaway = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      'Scam warning: @everyone Giving away my MacBook for free because I upgraded. First come first served. DM me on WhatsApp at +1 (202) 555-0106.',
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: true,
    observedAtTimestamp: NOW,
  });
  const warningPrefixedTicketOffer = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: WARNING_PREFIXED_TICKET_OFFER,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  for (const result of [
    copiedPitch,
    warningPrefixedGiveaway,
    warningPrefixedTicketOffer,
  ]) {
    assert.equal(result.isLikelyScam, false);
    assert.equal(result.requiresReview, true);
  }
});

test('requires both rare ticket-template anchors before auto-quarantine', () => {
  const openingAnchorOnly = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      'I have four amazing concert passes available. My plans changed, so I can no longer go. You can take all four or just a pair. Reach out if interested: +1 (202) 555-0107.',
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });
  const recipientAnchorOnly = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      'I have four concert passes available because my plans changed, and I am looking for someone who can truly enjoy the show. Take all four or just a pair. Reach out if interested: +1 (202) 555-0114.',
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });
  const harmlessMessages = [
    'Are passes still available for the Bruno Mars concert?',
    'My plans changed, so reach out if you want to meet at the venue.',
    'Does anyone know whether concert passes can be transferred in pairs?',
  ];

  for (const result of [openingAnchorOnly, recipientAnchorOnly]) {
    assert.equal(result.isLikelyScam, false);
    assert.equal(result.requiresReview, true);
    assert.equal(
      result.signalIds.includes('ticket_template_fingerprint'),
      false,
    );
  }

  for (const content of harmlessMessages) {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: false,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, false, content);
    assert.equal(result.requiresReview, false, content);
  }
});

test('keeps ordinary ticket discussion and a transparent face-value extra-ticket sale below the action gate', () => {
  const legitimateMessages = [
    'Is anyone else going to the Bruno Mars concert at Lucas Oil Stadium? I already bought four tickets for our group.',
    "Do concert tickets have to be transferred as a pair? I can no longer attend and am checking Ticketmaster's refund policy.",
    'I have one extra Bruno Mars ticket after a friend changed plans. I am selling it for exactly the $125 face value printed on the receipt. DM me here if you would like it.',
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

test('flags camera and lens scams without treating camera words as suspicious alone', () => {
  const scam = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      '@everyone Giving away my Canon EOS R5 camera and lenses for free because I upgraded. First come, first served. Message me on Whats App at +1 (202) 555-0102.',
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
      "I am donating my Sony A7 IV camera free of charge because I upgraded. Contact me on WhatsApp if you can't afford one: +1 (202) 555-0103.",
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
      '@ｅveryone g\u200biving away an iＰｈｏｎｅ and cаmera for f r e e. fіrst—come first—serve. D.M. if interested. Whаts App: ＋１（２０２）５５５－０１０８',
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
