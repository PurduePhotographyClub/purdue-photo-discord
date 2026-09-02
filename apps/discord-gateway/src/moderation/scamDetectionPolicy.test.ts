import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeScamMessage,
  normalizeScamText,
  type ScamSignalId,
} from './scamDetectionPolicy.js';

const NOW = Date.UTC(2026, 7, 7, 22, 19, 0);
const DAY_MS = 24 * 60 * 60 * 1_000;
const OLD_ACCOUNT = NOW - 365 * 24 * 60 * 60 * 1_000;
const ESTABLISHED_MEMBER = NOW - 90 * 24 * 60 * 60 * 1_000;
const CANON_R7_BODY_AND_LENS_GIVEAWAY = `Giving away my Canon EOS R7 Mirrorless Camera (Body Only), Hybrid Camera, 32.5 Megapixel (APS-C) CMOS Sensor, 4K Video, for Sports, Action, Content Creators, Vlogging Camera, Black
Comes with extra lens
DM me if interested`;
const SONY_A7_III_GIVEAWAY = `If you are in need of a camera, I am offering my Sony A7 III with the Sony 18–105mm f/4 lens as a giveaway. Both items come in their original boxes and are in nearly brand-new condition. I purchased them in December 2024, used them only for a few test shots, and then stored them carefully. I am passing them on because I recently purchased a drone, and I would prefer to give this camera to someone who genuinely needs one but may not be able to afford it. This is strictly first come, first served. No holds or partial reservations. Please send me a direct message if you are interested.`;
const REPEATED_CANON_UPGRADE_GIVEAWAY =
  'Just upgraded! Giving away my old Canon camera. It is still functional and in good shape. Perfect for photography enthusiasts or anyone wanting to start! DM me if interested in picking it up.';
const BRUNO_TICKET_GIVEAWAY_CAMPAIGN =
  "Hey @everyone, I'm giving away Bruno Mars tickets for free, my schedule for that day got so tight. LMK if anyone is interested in them. +1 (202) 555-0123";
const ARIANA_PRESALE_CAMPAIGN =
  'It is so crazy to write this here, but I am curious if there is any Ariana fan here interested in her August 2026 concert at United Center. I have a few presale tickets that I am looking to resell because my sister is seriously ill and I need to travel to be by her side. The seats are good too, offering a fantastic view. Please LMK if anyone is interested or knows anyone who might be interested, TYSM. Text me, iMessage, or WhatsApp +1 (202) 555-0124';
const CAMERA_UPGRADE_GIVEAWAY_VARIATIONS = [
  {
    label: 'great-condition Canon for photography beginners',
    content:
      '@everyone Just upgraded! Giving away my old Canon camera. It is still in great condition and works perfectly. Perfect for anyone interested in photography or wanting to get started. DM me if interested.',
  },
  {
    label: 'recent camera setup upgrade',
    content:
      'Hey everyone, I recently upgraded my camera setup and no longer need my old Canon. I would like to give it to someone who could make use of it. Message me if interested.',
  },
  {
    label: 'previous Canon after a new purchase',
    content:
      'Giving away my previous Canon camera since I purchased a new model. Still fully functional and in really good condition. First come first served, DM me.',
  },
  {
    label: 'new camera with old Canon starter story',
    content:
      'Just bought myself a new camera 📸 so I am giving my old Canon away to somebody who needs one. Great starter camera for photography. HMU if you want it.',
  },
  {
    label: 'extra Canon collecting dust',
    content:
      'Hello @everyone! I upgraded recently and have an extra Canon camera sitting around. Rather than letting it collect dust I would like to give it away. DM if interested.',
  },
  {
    label: 'free Canon after upgrade',
    content:
      "Free Canon camera! Recently upgraded and don't need my old one anymore. Everything works and it is in good shape. Send me a message if you would like it.",
  },
  {
    label: 'photography student Canon pitch',
    content:
      'Any photography students here need a camera? I just upgraded and would like to give my old Canon to somebody who can use it. DM me privately.',
  },
  {
    label: 'Canon DSLR for a beginner',
    content:
      'Giving out my Canon DSLR because I have a newer model now. It is used but still works perfectly and would be great for somebody getting into photography.',
  },
  {
    label: 'short Canon cam wording',
    content: 'just upgraded!! giving away old canon cam 📷 dm if interested',
  },
  {
    label: 'old camera condition shorthand',
    content:
      'Giving away my old camera, still works perfectly. msg me if you want it',
  },
  {
    label: 'new Sony replacing Canon',
    content:
      "Got a new Sony so I don't need my Canon anymore. Free to someone who needs it, PM me",
  },
  {
    label: 'free beginner camera',
    content:
      'FREE CAMERA 📸 perfect for beginners. I upgraded recently so I have no use for this one anymore. inbox me',
  },
  {
    label: 'extra camera for a new photographer',
    content:
      'Anyone wanting to start photography? Got an extra camera I am willing to give away. message privately',
  },
  {
    label: 'upgraded photography equipment with urgency',
    content:
      'Giving away photography equipment after upgrading my setup. First person to contact me gets it.',
  },
  {
    label: 'obfuscated Canon and DM',
    content:
      'Old C@non available for somebody who needs one. Just upgraded. D M me',
  },
  {
    label: 'obfuscated camera setup',
    content:
      'just upgraded my c4mera setup and giving the old one away, message if interested',
  },
  {
    label: 'camera emoji and lens bundle',
    content:
      '📷 + lens available at no cost since I bought a newer setup. pm for details',
  },
  {
    label: 'extra DSLR for photography student',
    content:
      'I have an extra DSLR I no longer need. Looking to give it to a photography student. Contact me privately.',
  },
] as const;
const BRUNO_MARS_TICKET_SCAM = `I have 4 amazing tickets for the Bruno Mars concert on Wed , Sep 9, 2026 at 7:00 PM at Lucas oil  Stadium , Indianapolis , Indiana.

Unfortunately, I’m no longer able to attend, so I’m looking to sell the tickets to someone who can truly enjoy the show.
You can take all 4 or just a pair.
Message me if you’re interested: +1 (202) 555-0104`;
const NEED_THEM_GONE_TICKET_SCAM = BRUNO_MARS_TICKET_SCAM.replace(
  'so I’m looking to sell the tickets to someone who can truly enjoy the show.',
  'so I need them gone. I want them to go to someone who can truly enjoy the show.',
);
const LETTING_THEM_GO_TICKET_SCAM = BRUNO_MARS_TICKET_SCAM.replace(
  'so I’m looking to sell the tickets to someone who can truly enjoy the show.',
  'so I’m letting them go. I want them to go to someone who can truly enjoy the show.',
);
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
const FACE_VALUE_INSIDE_SALE_PHRASE = BRUNO_MARS_TICKET_SCAM.replace(
  'looking to sell the tickets to someone',
  'looking to sell the tickets at face value to someone',
);
const COPIED_MESSAGE_PREFIXED_NOUN_OMITTED_TICKET_SCAM = `Heads up, this copied message is circulating:\n\n${NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM}`;
const FYI_PREFIXED_NOUN_OMITTED_TICKET_SCAM = `FYI, sharing the copied scam so everyone knows what to avoid:\n\n${NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM}`;
const BEWARE_PREFIXED_NOUN_OMITTED_TICKET_SCAM = `Beware, copied scam follows:\n\n${NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM}`;
const DO_NOT_CONTACT_PREFIXED_NOUN_OMITTED_TICKET_SCAM = `Do not contact this person; they posted:\n\n${NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM}`;
const I_HAVE_FOUR_AVAILABLE_NOUN_OMITTED_TICKET_SALE =
  NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM.replace(
    'I have 4 amazing for the Bruno Mars concert',
    'I have four available for the Bruno Mars concert',
  );
const THERE_ARE_FOUR_AVAILABLE_NOUN_OMITTED_TICKET_SALE =
  NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM.replace(
    'I have 4 amazing for the Bruno Mars concert',
    'There are four available for the Bruno Mars concert',
  );
const GRAMMATICAL_NOUN_OMITTED_TICKET_SALE =
  NOUN_OMITTED_BRUNO_MARS_TICKET_SCAM.replace(
    'looking to sell the to someone',
    'looking to sell to someone',
  );
const REORDERED_NOUN_OMITTED_TICKET_SALE =
  'My plans changed and I can no longer attend the Bruno Mars show at Lucas Oil Stadium. Four are available, either all four or a pair, and I want to resell them to someone who will truly enjoy the concert. DM me if interested at +1 (202) 555-0118.';
const ANOTHER_FAN_NOUN_OMITTED_TICKET_SALE =
  'My plans changed and I can no longer attend the Bruno Mars show at Lucas Oil Stadium. Four are available, either all four or a pair, and I want to resell them to another fan. DM me if interested at +1 (202) 555-0117.';
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

for (const { content, label } of [
  { content: NEED_THEM_GONE_TICKET_SCAM, label: 'need them gone' },
  { content: LETTING_THEM_GO_TICKET_SCAM, label: 'letting them go' },
]) {
  test(`quarantines the explicit ticket template using ${label} sale wording`, () => {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: false,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, true, label);
    assert.equal(result.requiresReview, false, label);
    assert.ok(result.signalIds.includes('ticket_template_fingerprint'), label);
  });
}

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

test('sends face-value wording inside the ticket sale phrase to review instead of quarantine', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: FACE_VALUE_INSIDE_SALE_PHRASE,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, false);
  assert.equal(result.requiresReview, true);
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

test('routes an FYI-prefixed copied scam to review instead of quarantine', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: FYI_PREFIXED_NOUN_OMITTED_TICKET_SCAM,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, false);
  assert.equal(result.requiresReview, true);
});

for (const { content, label } of [
  {
    content: BEWARE_PREFIXED_NOUN_OMITTED_TICKET_SCAM,
    label: 'Beware, copied scam follows',
  },
  {
    content: DO_NOT_CONTACT_PREFIXED_NOUN_OMITTED_TICKET_SCAM,
    label: 'Do not contact this person; they posted',
  },
]) {
  test(`routes the ${label} warning prefix to review instead of quarantine`, () => {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: false,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, false, label);
    assert.equal(result.requiresReview, true, label);
    assert.ok(result.signalIds.includes('ticket_template_fingerprint'), label);
  });
}

for (const { content, label } of [
  {
    content: I_HAVE_FOUR_AVAILABLE_NOUN_OMITTED_TICKET_SALE,
    label: 'I have four available',
  },
  {
    content: THERE_ARE_FOUR_AVAILABLE_NOUN_OMITTED_TICKET_SALE,
    label: 'There are four available',
  },
]) {
  test(`routes the noun-omitted ${label} opening to review instead of quarantine`, () => {
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

for (const { content, label } of [
  {
    content: GRAMMATICAL_NOUN_OMITTED_TICKET_SALE,
    label: 'grammatical sell to variant',
  },
  {
    content: REORDERED_NOUN_OMITTED_TICKET_SALE,
    label: 'reordered structural paraphrase',
  },
  {
    content: ANOTHER_FAN_NOUN_OMITTED_TICKET_SALE,
    label: 'another fan paraphrase',
  },
]) {
  test(`routes the noun-omitted ${label} to review instead of quarantine`, () => {
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

for (const { content, label } of [
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
    'Ticketmaster says four Bruno Mars tickets are available, including pairs. I can no longer attend, so I canceled mine at face value. Check the official venue site for current availability.',
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

test('quarantines the exact Canon R7 body-and-lens giveaway from an established member', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: CANON_R7_BODY_AND_LENS_GIVEAWAY,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, true);
  assert.equal(result.requiresReview, false);
  assert.ok(result.signalIds.includes('known_camera_giveaway_campaign'));
  assert.ok(result.signalIds.includes('camera_listing_fingerprint'));
  assert.ok(result.signalIds.includes('direct_contact'));
  assert.ok(result.signalIds.includes('giveaway_lure'));
  assert.ok(result.signalIds.includes('high_value_item'));
  assert.equal(result.signalIds.includes('phone_number'), false);
  assert.equal(result.signalIds.includes('off_platform_contact'), false);
  assert.equal(result.signalIds.includes('broadcast_mention'), false);
});

for (const { content, label, mentionsEveryone } of [
  {
    content: SONY_A7_III_GIVEAWAY,
    label: 'direct post',
    mentionsEveryone: false,
  },
  {
    content: `@here ${SONY_A7_III_GIVEAWAY}`,
    label: '@here broadcast',
    mentionsEveryone: true,
  },
]) {
  test(`quarantines the supplied Sony A7 III giveaway from an established member: ${label}`, () => {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, true, label);
    assert.equal(result.requiresReview, false, label);
    assert.ok(result.signalIds.includes('camera_giveaway_fingerprint'), label);
    assert.ok(result.signalIds.includes('direct_contact'), label);
    assert.ok(result.signalIds.includes('giveaway_lure'), label);
    assert.ok(result.signalIds.includes('high_value_item'), label);
    assert.ok(result.signalIds.includes('urgency'), label);
    assert.equal(result.signalIds.includes('ticket_bundle'), false, label);
  });
}

for (const { content, label } of [
  {
    content: CANON_R7_BODY_AND_LENS_GIVEAWAY.replace(
      'extra lens',
      'extra lense',
    ),
    label: 'extra lense misspelling',
  },
  {
    content: REPEATED_CANON_UPGRADE_GIVEAWAY,
    label: 'repeated just-upgraded Canon campaign',
  },
  {
    content: REPEATED_CANON_UPGRADE_GIVEAWAY.replace(
      'wanting to start',
      'to start',
    ).replace('picking it up.', 'picking it'),
    label: 'shortened Canon campaign',
  },
]) {
  test(`quarantines the established-member camera scam with ${label}`, () => {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: false,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, true, label);
    assert.equal(result.requiresReview, false, label);
    assert.ok(result.signalIds.includes('known_camera_giveaway_campaign'));
  });
}

for (const { content, label } of CAMERA_UPGRADE_GIVEAWAY_VARIATIONS) {
  test(`quarantines the confirmed camera giveaway variation: ${label}`, () => {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: content.includes('@everyone'),
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, true, label);
    assert.equal(result.requiresReview, false, label);
    assert.ok(result.signalIds.includes('camera_giveaway_fingerprint'), label);
  });
}

test('quarantines every compound camera variation from a new account and new member', () => {
  for (const { content, label } of CAMERA_UPGRADE_GIVEAWAY_VARIATIONS) {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: NOW - 2 * DAY_MS,
      content,
      joinedTimestamp: NOW - 5 * 60 * 1_000,
      mentionsEveryone: content.includes('@everyone'),
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, true, label);
    assert.equal(result.requiresReview, false, label);
  }
});

test('reviews a plausible direct camera gift without automatically punishing the member', () => {
  for (const content of [
    'I upgraded recently and want to give my old Canon to a photography student. DM me if interested.',
    'I upgraded recently and want to give my old Canon to a photography student. DM me if you can meet on campus.',
    'Just upgraded, giving away old Canon cam. DM me if interested. We can meet on campus.',
  ]) {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: false,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, false, content);
    assert.equal(result.requiresReview, true, content);
    assert.ok(
      result.signalIds.includes('camera_giveaway_fingerprint'),
      content,
    );
  }
});

test('keeps camera-giveaway keywords safe when the compound scam structure is absent', () => {
  const legitimateMessages = [
    'Does Purdue provide Lightroom or Lightroom Classic for free on personal devices?',
    "Sony's market capitalization passed another electronics company this week.",
    'Selling my Canon camera for $450 with the receipt and shutter count. DM me if you want to inspect it on campus.',
    'I upgraded my camera and am giving my old Canon to my cousin for graduation.',
    'My old Canon camera still works perfectly. DM me if you want sample RAW files from it.',
    'The club is giving away a donated Canon through its public raffle. Enter through the official club form; staff will not DM entrants.',
    'Giving away camera stickers left over from the callout. DM me if you want one.',
    'Giving away my old camera strap after upgrading. DM me if you want the strap.',
    'Purdue students get free camera checkout through the equipment desk. Contact the equipment manager for the checkout form.',
    '@everyone I am willing to give feedback on your camera portfolio. Message me if interested.',
    '@everyone Does anyone know a free camera app? DM me recommendations.',
    '@everyone I am giving a presentation about free camera software. Message me if you want the slides.',
    '@everyone I am willing to give feedback on your MacBook setup. DM me if interested.',
    '@everyone I would like to give a presentation about laptop security. DM me if you want the slides.',
    'Giving away camera gear after upgrading my setup. DM me if interested.',
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

test('does not let common camera obfuscation or an injected accessory evade detection', () => {
  const evasionMessages = [
    {
      autoQuarantine: false,
      content:
        'Just upgraded! Giving away my old c@mera. It still works perfectly and is great for photography beginners. DM me if interested.',
    },
    {
      autoQuarantine: false,
      content:
        'Just upgraded! Giving away my old cam3ra. It still works perfectly and is great for photography beginners. DM me if interested.',
    },
    {
      autoQuarantine: true,
      content:
        'Just upgraded! Giving away my old Can0n cam. It still works perfectly and is great for photography beginners. DM me if interested.',
    },
    {
      autoQuarantine: false,
      content:
        'Just upgraded! Giving away my old Canon camera with a camera bag. It still works perfectly. DM me if interested.',
    },
  ];

  for (const { autoQuarantine, content } of evasionMessages) {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: false,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, autoQuarantine, content);
    assert.equal(result.requiresReview, !autoQuarantine, content);
    assert.ok(
      result.signalIds.includes('camera_giveaway_fingerprint'),
      content,
    );
  }
});

test('does not let urgency and a broadcast scam hide behind local-handoff wording', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      '@everyone Just upgraded! Giving away my old Canon camera. It still works perfectly. First person to contact me gets it. We can meet on campus.',
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: true,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, true);
  assert.equal(result.requiresReview, false);
});

test('routes a generic free season-ticket transfer to review without punishing the member', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      "Is anyone interested in my student football season tickets for free? I won't be able to attend anymore due to my work schedule. HMU +1 202 555 0122",
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, false);
  assert.equal(result.requiresReview, true);
  assert.ok(result.signalIds.includes('ticket_offer'));
});

for (const { content, label } of [
  {
    content: BRUNO_TICKET_GIVEAWAY_CAMPAIGN,
    label: 'short Bruno Mars giveaway with LMK',
  },
  {
    content: ARIANA_PRESALE_CAMPAIGN,
    label: 'copied Ariana presale campaign',
  },
]) {
  test(`quarantines the established-member ticket scam with ${label}`, () => {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: content.includes('@everyone'),
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, true, label);
    assert.equal(result.requiresReview, false, label);
    assert.ok(result.signalIds.includes('ticket_offer'), label);
  });
}

for (const { campaign, prefix } of [
  {
    campaign: ARIANA_PRESALE_CAMPAIGN,
    prefix: 'Does this look legit?',
  },
  {
    campaign: BRUNO_TICKET_GIVEAWAY_CAMPAIGN,
    prefix: 'Does this seem suspicious?',
  },
  {
    campaign: ARIANA_PRESALE_CAMPAIGN,
    prefix: 'Can someone verify this?',
  },
]) {
  test(`routes a ${prefix} copied-campaign report to review`, () => {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content: `${prefix} Someone sent me this:\n\n${campaign}`,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: campaign.includes('@everyone'),
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, false, prefix);
    assert.equal(result.requiresReview, true, prefix);
  });
}

test('does not let a scammer bypass quarantine with a bare legitimacy question', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: `Does this look legit?\n\n${BRUNO_TICKET_GIVEAWAY_CAMPAIGN}`,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: true,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, true);
  assert.equal(result.requiresReview, false);
});

for (const { content, label } of [
  {
    content:
      'Giving away two Bruno Mars tickets for free. LMK if interested at +1 (202) 555-0125.',
    label: 'ticket giveaway without an inability story',
  },
  {
    content:
      'I have a few great seats available because I need to travel for a family emergency. Text me on iMessage at +1 (202) 555-0126.',
    label: 'seat-only resale wording',
  },
  {
    content:
      'Giving away two Bruno Mars tickets because my work schedule got tight. LMK if interested at +1 (202) 555-0127.',
    label: 'ordinary Bruno giveaway with a schedule conflict',
  },
  {
    content:
      'I have a few presale tickets to resell because my sister is ill and I need to travel. The seats have a fantastic view. DM me at +1 (202) 555-0128.',
    label: 'generic family-travel resale story',
  },
]) {
  test(`routes the ${label} to review without automatic punishment`, () => {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: false,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, false, label);
    assert.equal(result.requiresReview, true, label);
    assert.ok(result.signalIds.includes('ticket_offer'), label);
  });
}

test('does not treat generic Sony marketing copy as the known Canon campaign', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content:
      'Giving away my Sony A7 IV body only hybrid camera for content creators. It is marketed as a vlogging camera. DM me if interested.',
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, false);
  assert.equal(result.requiresReview, true);
  assert.equal(
    result.signalIds.includes('known_camera_giveaway_campaign'),
    false,
  );
});

for (const { content, label } of [
  {
    content:
      'Giving away my Sony a7 IV full-frame mirrorless camera body with a 33MP sensor and 4K 60p video. Includes an extra FE 24-70mm lens. Message me if interested.',
    label: 'Sony full-frame body with extra zoom lens',
  },
  {
    content:
      'I am donating my Nikon Z8 mirrorless camera body, featuring a 45.7-megapixel stacked sensor and 8K video. It comes with a spare NIKKOR Z lens. Inbox me if interested.',
    label: 'Nikon body with spare NIKKOR lens',
  },
  {
    content:
      'Giving out a Fujifilm X-T5 camera body with a 40.2MP APS-C sensor and 6.2K recording, bundled with an extra XF lens. Contact me if interested.',
    label: 'Fujifilm body bundled with extra lens',
  },
]) {
  test(`routes the generic structurally complete ${label} giveaway to review`, () => {
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

for (const { content, label, signals } of [
  {
    content:
      'Giving away my Sony a7 IV full-frame mirrorless camera body with a 33MP sensor and 4K video. Includes an extra FE lens. Contact me on WhatsApp at +1 (202) 555-0115.',
    label: 'off-platform phone contact',
    signals: ['off_platform_contact', 'phone_number'],
  },
  {
    content:
      'Giving away my Nikon Z8 mirrorless camera body with a 45.7MP stacked sensor and 8K video. Includes an extra NIKKOR lens. First come, first served. Message me if interested.',
    label: 'first-come urgency',
    signals: ['urgency'],
  },
] as const) {
  test(`quarantines a generic structural camera giveaway with ${label}`, () => {
    const result = analyzeScamMessage({
      accountCreatedTimestamp: OLD_ACCOUNT,
      content,
      joinedTimestamp: ESTABLISHED_MEMBER,
      mentionsEveryone: false,
      observedAtTimestamp: NOW,
    });

    assert.equal(result.isLikelyScam, true, label);
    assert.equal(result.requiresReview, false, label);
    for (const signal of signals) {
      assert.ok(result.signalIds.includes(signal), `${label}: ${signal}`);
    }
  });
}

for (const { content, label } of [
  {
    content:
      'Giving away my Panasonic Lumix S5 II mirrorless camera body with a 24MP full-frame sensor, 6K recording, and an extra Lumix lens. PM me if interested.',
    label: 'PM me contact wording',
  },
  {
    content:
      'Giving away my OM System OM-1 mirrorless camera body with a stacked 20MP sensor, 4K video, and a spare M.Zuiko lens. Hit me up if interested.',
    label: 'hit me up contact wording',
  },
  {
    content:
      'Free to a good home: Leica SL3 mirrorless camera body with a 60MP full-frame sensor, 8K video, and an extra Leica lens. Message me if interested.',
    label: 'free to a good home wording',
  },
  {
    content:
      'Giving away my Hasselblad X2D camera body with a 100MP sensor and an extra XCD lens. Ping me privately if interested.',
    label: 'unrecognized private-contact wording',
  },
]) {
  test(`routes the generic structural giveaway with ${label} to review`, () => {
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

test('keeps camera giveaway lookalikes and legitimate gear activity out of quarantine', () => {
  const legitimateMessages = [
    'Has anyone compared the Canon EOS R7 and Sony a7 IV for sports photography? I am especially curious about autofocus, sensor crop, and 4K heat limits.',
    'I can loan the club Canon EOS R7 body and RF lens to the event photographer after they complete the equipment checkout form. Please return both to the gear room Friday.',
    'Selling my used Nikon Z8 camera body and 24-70mm lens for $2,900 with shutter count and receipt posted in the marketplace channel. Local pickup through the club sale desk.',
    'Giving away a free Canon RF lens cap that no longer fits my bag. DM me if you want this small plastic accessory.',
    'Giving away a spare camera body cap from my old kit. Message me if interested in this plastic dust cover.',
    'Free microfiber camera cleaning cloth at the checkout desk. DM me if you want it held until the meeting.',
    'Giving away an unused camera strap from a conference gift bag. Contact me if interested.',
    'Giving away a basic 52mm UV lens filter. DM me if this small accessory fits your lens.',
    'Free padded camera case with a broken zipper. Message me if interested.',
    'Giving away a spare camera battery. DM me if this small accessory fits your camera.',
    'Giving away my extra camera charger for free. PM me if interested.',
    'Free 64GB camera memory card after the meeting. Hit me up if you need one.',
    'The photography club is giving away a donated Canon EOS R7 through its documented annual member raffle. Enter on the official club website; the winner will be announced publicly, and staff will not request DMs.',
    'The photography club is offering a donated Sony A7 III camera as a giveaway through its documented annual raffle. Enter on the official club website; staff will not request DMs.',
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

test('routes a warning that quotes the exact Canon R7 giveaway to review without quarantine', () => {
  const result = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: `Scam warning: Someone posted this message:\n\n${CANON_R7_BODY_AND_LENS_GIVEAWAY}`,
    joinedTimestamp: ESTABLISHED_MEMBER,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(result.isLikelyScam, false);
  assert.equal(result.requiresReview, true);
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
    'Does Purdue allow students to use Lightroom or Lightroom Classic for free on personal devices?',
    'A Polaroid photo of my friends was taken for free. I still keep it because it is such a good memory.',
    'You got a ticket to the Maldives to go with it?',
    'I am free Friday before noon and between 2 and 3 PM. I have a bike, so anywhere on campus is fine.',
    'I guess Discord thinks I am saying that I have a bike to give away for free.',
    'Do you happen to have a Yamaha piano, Nintendo Switch OLED, Taylor guitar, and Leica camera as well?',
    'For sale: Sony A6700 mirrorless camera with its box, strap, battery, Sigma 18-50mm lens, shutter count, and receipt. Asking $1,600 OBO for local pickup. DM me for more pictures.',
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

test('routes a simple established-member Nikon Z8 giveaway to review and uses age only as a modifier', () => {
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
  assert.equal(established.requiresReview, true);
  assert.equal(newcomer.isLikelyScam, true);
  assert.equal(harmlessNewcomer.isLikelyScam, false);
});

test('treats a suspicious offer during a member first day as recently joined without flagging harmless posts', () => {
  const suspiciousContent =
    'Giving away a Nikon Z8 camera because I no longer need it. DM me if interested.';
  const recentMember = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: suspiciousContent,
    joinedTimestamp: NOW - DAY_MS + 1,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });
  const establishedMember = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: suspiciousContent,
    joinedTimestamp: NOW - DAY_MS,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });
  const harmlessRecentMember = analyzeScamMessage({
    accountCreatedTimestamp: OLD_ACCOUNT,
    content: 'Hi everyone, I joined today and shoot with a Nikon Z8.',
    joinedTimestamp: NOW - 12 * 60 * 60 * 1_000,
    mentionsEveryone: false,
    observedAtTimestamp: NOW,
  });

  assert.equal(recentMember.isLikelyScam, true);
  assert.ok(recentMember.signalIds.includes('new_server_member'));
  assert.equal(establishedMember.isLikelyScam, false);
  assert.equal(establishedMember.requiresReview, true);
  assert.equal(
    establishedMember.signalIds.includes('new_server_member'),
    false,
  );
  assert.equal(harmlessRecentMember.isLikelyScam, false);
  assert.equal(harmlessRecentMember.requiresReview, false);
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
