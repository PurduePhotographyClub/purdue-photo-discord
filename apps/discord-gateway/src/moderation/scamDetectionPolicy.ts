export type ScamSignalId =
  | 'broadcast_mention'
  | 'camera_listing_fingerprint'
  | 'direct_contact'
  | 'giveaway_lure'
  | 'high_value_item'
  | 'known_camera_giveaway_campaign'
  | 'known_ticket_scam_campaign'
  | 'new_account'
  | 'new_server_member'
  | 'off_platform_contact'
  | 'payment_request'
  | 'phone_number'
  | 'replacement_story'
  | 'ticket_bundle'
  | 'ticket_offer'
  | 'ticket_template_fingerprint'
  | 'unable_to_attend_story'
  | 'urgency';

export interface ScamDetectionInput {
  accountCreatedTimestamp: number | null;
  content: string;
  joinedTimestamp: number | null;
  mentionsEveryone: boolean;
  observedAtTimestamp: number;
}

export interface ScamDetectionResult {
  isLikelyScam: boolean;
  requiresReview: boolean;
  score: number;
  signalIds: ScamSignalId[];
}

interface ScamSignalRule {
  id: ScamSignalId;
  matches: (context: DetectionContext) => boolean;
  points: number;
}

interface DetectionContext extends ScamDetectionInput {
  normalizedContent: string;
  phoneNumberPresent: boolean;
}

const MAX_SCANNED_CONTENT_LENGTH = 4_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const NEW_ACCOUNT_AGE_MS = 7 * DAY_MS;
const NEW_MEMBER_AGE_MS = 10 * 60 * 1_000;

const CONFUSABLES = new Map<string, string>([
  ['а', 'a'],
  ['α', 'a'],
  ['в', 'b'],
  ['с', 'c'],
  ['е', 'e'],
  ['ε', 'e'],
  ['һ', 'h'],
  ['і', 'i'],
  ['ι', 'i'],
  ['ј', 'j'],
  ['к', 'k'],
  ['м', 'm'],
  ['о', 'o'],
  ['ο', 'o'],
  ['р', 'p'],
  ['ρ', 'p'],
  ['ѕ', 's'],
  ['т', 't'],
  ['у', 'y'],
  ['х', 'x'],
  ['χ', 'x'],
]);

const GIVEAWAY_PATTERN =
  /\b(?:give|giving|gave)\s+(?:it\s+)?(?:away|out)\b|\b(?:want\s+to\s+give|donat(?:e|ing)|handing\s+out)\b|\b(?:for\s+free|free\s+of\s+charge|free\s+to\s+(?:a\s+)?good\s+home)\b|\bf\s*r\s*e\s*e\s+giveaway\b/u;
const DIRECT_CONTACT_PATTERN =
  /\b(?:d\s*m|p\s*m|direct\s+message|private\s+message|message|contact|inbox|text)\s+(?:me|if\s+(?:you\s+are\s+)?interested)\b|\b(?:d\s*m|p\s*m)\s+if\b|\b(?:reach\s+out|hit\s+me\s+up)(?:\s+if\s+interested)?\b|\b(?:h\s*m\s*u|l\s*m\s*k)\b/u;
const OFF_PLATFORM_CONTACT_PATTERN =
  /\b(?:whats\s*app|i\s*message|telegram|signal\s+app|kik)\b|\bwa\s+me\b/u;
const URGENCY_PATTERN =
  /\b(?:strictly\s+)?first\s+come\s+first\s+serve(?:d)?\b|\b(?:act\s+fast|hurry|today\s+only|limited\s+time)\b/u;
const HIGH_VALUE_ITEM_PATTERN =
  /\b(?:mac\s*book|iphone|ipad|laptop|playstation|ps\s*5|xbox|camera|dslr|mirrorless|canon(?:\s+eos)?|nikon(?:\s+z)?|sony(?:\s+(?:alpha|a\s*\d))?|fuji(?:film)?|leica|hasselblad|gopro|drone|lens(?:es)?)\b/u;
const CAMERA_DEVICE_PATTERN =
  /\b(?:camera|dslr|mirrorless|canon\s+eos|nikon\s+z|sony\s+(?:alpha|a\s*\d)|fuji(?:film)?\s+x|leica\s+[a-z0-9]+|hasselblad\s+[a-z0-9]+)\b/u;
const CAMERA_BODY_DETAIL_PATTERN =
  /\b(?:body\s+only|camera\s+body|mirrorless\s+camera\s+body|dslr\s+body)\b/u;
const CAMERA_SENSOR_DETAIL_PATTERN =
  /\b(?:\d{1,3}(?:\s+\d)?\s*(?:mp|mega\s*pixel(?:s)?)|aps\s*c|full\s*frame|cmos\s+sensor|stacked\s+sensor)\b/u;
const CAMERA_VIDEO_DETAIL_PATTERN =
  /\b[2-9](?:\s+\d)?\s*k(?:\s+\d{2,3}\s*p)?\s+(?:uhd\s+)?(?:video|recording)\b/u;
const CAMERA_GEAR_BUNDLE_PATTERN =
  /\b(?:(?:comes?\s+with|includes?|bundled\s+with|ships?\s+with)\s+(?:an?\s+)?(?:extra|spare|additional|second)\s+(?:[a-z0-9]+\s+){0,3}(?:lens|battery|charger|camera\s+bag|memory\s+card)|(?:extra|spare|additional|second)\s+(?:[a-z0-9]+\s+){0,3}(?:lens|battery|charger|camera\s+bag|memory\s+card)\s+(?:included|provided))\b/u;
const CAMERA_ACCESSORY_ONLY_PATTERN =
  /\b(?:lens\s+cap|body\s+cap|(?:lens\s+|camera\s+)?(?:cleaning\s+)?cloth|camera\s+(?:strap|case|bag|battery|charger|memory\s+card)|(?:uv|nd)\s+(?:lens\s+)?filter|(?:spare|extra)\s+(?:[a-z0-9]+\s+){0,3}(?:camera\s+)?(?:battery|charger|memory\s+card))\b/u;
const CAMERA_BODY_CAP_PATTERN = /\b(?:camera\s+)?body\s+cap\b/u;
const KNOWN_CAMERA_GIVEAWAY_MODEL_PATTERN = /\bcanon\s+eos\s+r\s*7\b/u;
const KNOWN_CAMERA_GIVEAWAY_RESOLUTION_PATTERN =
  /\b32(?:\s+5)?\s*(?:mp|mega\s*pixel(?:s)?)\b/u;
const KNOWN_CAMERA_GIVEAWAY_SENSOR_PATTERN = /\baps\s*c\s+cmos\s+sensor\b/u;
const KNOWN_CAMERA_GIVEAWAY_EXTRA_LENS_PATTERN =
  /\bcomes?\s+with\s+(?:an?\s+)?extra\s+lens(?:e|es)?\b/u;
const KNOWN_CAMERA_GIVEAWAY_MARKER_PATTERNS = [
  /\bbody\s+only\b/u,
  /\bhybrid\s+camera\b/u,
  /\b(?:for\s+)?sports\s+action\b/u,
  /\bcontent\s+creators?\b/u,
  /\bvlogging\s+camera\b/u,
] as const;
const KNOWN_CAMERA_UPGRADE_MODEL_PATTERN = /\b(?:old\s+)?canon\s+camera\b/u;
const KNOWN_CAMERA_UPGRADE_STORY_PATTERN = /\bjust\s+upgraded\b/u;
const KNOWN_CAMERA_UPGRADE_CONDITION_PATTERN =
  /\bstill\s+functional\b.*\b(?:in\s+)?good\s+shape\b/u;
const KNOWN_CAMERA_UPGRADE_AUDIENCE_PATTERN =
  /\bperfect\s+for\s+photography\s+enthusiasts\b/u;
const KNOWN_CAMERA_UPGRADE_PICKUP_PATTERN =
  /\binterested\s+in\s+picking\s+it(?:\s+up)?\b/u;
const REPLACEMENT_STORY_PATTERN =
  /\b(?:just\s+got|got|bought)\s+(?:myself\s+)?a\s+new\b|\b(?:new\s+model|because\s+i\s+upgraded|since\s+i\s+upgraded|perfect\s+(?:health|condition)|good\s+as\s+new|cannot\s+afford|can\s+not\s+afford|can\s+t\s+afford|in\s+need\s+of)\b/u;
const PAYMENT_REQUEST_PATTERN =
  /\b(?:shipping|delivery|courier|insurance|processing)\s+fee\b|\bpay\s+(?:only\s+)?(?:for\s+)?(?:shipping|postage|delivery)\b|\b(?:cash\s*app|zelle|venmo|gift\s+card|crypto(?:currency)?)\b/u;
const TICKET_ITEM_PATTERN = /\b(?:tickets?|passes?|seats?)\b/u;
const TICKET_SALE_PATTERN =
  /\b(?:sell(?:ing)?|resell(?:ing)?|for\s+sale|looking\s+to\s+sell|available|letting\s+(?:it|them)\s+go|need\s+(?:it|them)\s+gone)\b/u;
const UNABLE_TO_ATTEND_PATTERN =
  /\b(?:no\s+longer|not)\s+able\s+to\s+(?:attend|make\s+it|go)\b|\bunable\s+to\s+(?:attend|make\s+it|go)\b|\b(?:cannot|couldnot|can\s+(?:not|t|no\s+longer)|could\s+(?:not|t|no\s+longer)|will\s+(?:not|t|no\s+longer)|won\s+t)\s+(?:be\s+able\s+to\s+)?(?:attend|make\s+it|go)\b|\bplans?\s+changed\b|\b(?:my\s+)?schedule(?:\s+[a-z0-9]+){0,5}\s+(?:got\s+)?(?:(?:so|too|very)\s+)?tight\b|\b(?:family|mother|father|mom|dad|sister|brother|child|partner|spouse)\s+(?:is\s+)?(?:seriously\s+)?(?:ill|sick|hospitalized)\b|\bneed\s+to\s+travel\b/u;
const TICKET_BUNDLE_PATTERN =
  /\b(?:[2-9]|\d{2,}|two|three|four|five|six|seven|eight|nine|ten|few|several)\s+(?:[a-z0-9]+\s+){0,2}(?:tickets?|passes?)\b|\b(?:all\s+(?:[2-9]|\d{2,}|two|three|four|five|six|seven|eight|nine|ten)|both(?:\s+(?:tickets?|passes?))?|just\s+(?:a\s+)?pair|(?:a|one)\s+pair)\b/u;
const TICKET_TEMPLATE_OPENING_PATTERN =
  /\b(?:amazing|great|excellent)\s+(?:concert\s+)?(?:tickets?|passes?)\b/u;
const TICKET_TEMPLATE_RECIPIENT_PATTERN =
  /\bsomeone\s+who\s+(?:can|will)\s+(?:truly\s+)?enjoy\s+the\s+(?:show|concert|event|game)\b/u;
const TICKET_TEMPLATE_OMITTED_OPENING_PATTERN =
  /\b(?:i|we)\s+have\s+(?:[2-9]|\d{2,}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:amazing|great|excellent)\s+for\s+the\s+(?:[a-z0-9]+\s+){1,8}(?:concert|show|game|event)\b/u;
const TICKET_TEMPLATE_AVAILABLE_QUANTITY_PATTERN =
  /\b(?:(?:i|we)\s+have\s+|there\s+(?:are|is)\s+)?(?:[2-9]|\d{2,}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:are|is)\s+)?(?:available|for\s+sale)\b/u;
const TICKET_TEMPLATE_EVENT_CONTEXT_PATTERN =
  /\b(?:concert|show|festival|game|match|performance)\b/u;
const TICKET_TEMPLATE_CORRUPTED_SALE_PATTERN =
  /\blooking\s+to\s+sell\s+the\s+to\s+someone\s+who\s+(?:can|will)\s+(?:truly\s+)?enjoy\s+the\s+(?:show|concert|event|game)\b/u;
const KNOWN_BRUNO_GIVEAWAY_EVENT_PATTERN = /\bbruno\s+mars\b/u;
const KNOWN_BRUNO_GIVEAWAY_SCHEDULE_PATTERN =
  /\bmy\s+schedule\s+for\s+that\s+day\s+got\s+so\s+tight\b/u;
const KNOWN_BRUNO_GIVEAWAY_CONTACT_PATTERN =
  /\bl\s*m\s*k\s+if\s+anyone\s+is\s+interested\s+in\s+(?:it|them)\b/u;
const KNOWN_FAMILY_RESALE_INTRO_PATTERN =
  /\b(?:it\s+is|its)\s+so\s+crazy\s+to\s+write\s+this\s+here\b/u;
const KNOWN_FAMILY_RESALE_EVENT_PATTERN =
  /\bariana\s+fan\s+here\b.*\baugust\s+2026\b.*\bunited\s+center\b/u;
const KNOWN_FAMILY_RESALE_OPENING_PATTERN =
  /\b(?:few|several)\s+presale\s+(?:tickets?|passes?|seats?)\b/u;
const KNOWN_FAMILY_RESALE_STORY_PATTERN =
  /\bmy\s+sister\s+is\s+seriously\s+ill\b.*\bneed\s+to\s+travel\s+to\s+be\s+by\s+her\s+side\b/u;
const KNOWN_FAMILY_RESALE_VIEW_PATTERN =
  /\bseats\s+are\s+good\b.*\boffering\s+a\s+fantastic\s+view\b/u;
const KNOWN_FAMILY_RESALE_CONTACT_PATTERN =
  /\b(?:please|pls)\s+l\s*m\s*k\s+if\s+anyone\s+(?:is|s)\s+interested\s+or\s+knows\s+anyone\s+who\s+might\s+be\s+interested\b/u;
const FACE_VALUE_SALE_PATTERN = /\bface\s+value\b/u;
const REPORTED_SCAM_CONTEXT_PATTERN =
  /\b(?:scam\s+warning|is\s+this\s+(?:a\s+)?scam|someone\s+sent\s+me\s+this|heads\s+up\s+this\s+copied\s+message\s+is\s+circulating|fyi\s+sharing\s+(?:the|a|this)\s+copied\s+scam\s+so\s+(?:everyone|people)\s+(?:knows?|know)\s+what\s+to\s+avoid|beware\s+(?:a\s+|the\s+|this\s+)?(?:copied\s+)?scam\s+(?:follows?|below)|reporting\s+(?:a|this)\s+scam|this\s+(?:message|post)\s+is\s+a\s+scam|do\s+not\s+(?:d\s*m|message|contact|call|text)\s+this\s+(?:person|user|account))\b|^(?:(?:does|do)\s+this\s+(?:look|seem)\s+(?:legit(?:imate)?|real|suspicious)|is\s+this\s+(?:legit(?:imate)?|real)|can\s+someone\s+verify\s+this)\s+(?:someone\s+sent\s+me\s+this|i\s+received\s+this|this\s+was\s+posted|here\s+is\s+the\s+message|the\s+message\s+follows)\b/u;

function matchesExplicitTicketTemplate(normalizedContent: string) {
  return (
    TICKET_ITEM_PATTERN.test(normalizedContent) &&
    TICKET_TEMPLATE_OPENING_PATTERN.test(normalizedContent) &&
    TICKET_TEMPLATE_RECIPIENT_PATTERN.test(normalizedContent)
  );
}

function matchesNounOmittedTicketStructure(normalizedContent: string) {
  const hasQuantityOpening =
    TICKET_TEMPLATE_OMITTED_OPENING_PATTERN.test(normalizedContent) ||
    TICKET_TEMPLATE_AVAILABLE_QUANTITY_PATTERN.test(normalizedContent);

  return (
    hasQuantityOpening &&
    TICKET_TEMPLATE_EVENT_CONTEXT_PATTERN.test(normalizedContent) &&
    TICKET_SALE_PATTERN.test(normalizedContent) &&
    UNABLE_TO_ATTEND_PATTERN.test(normalizedContent) &&
    TICKET_BUNDLE_PATTERN.test(normalizedContent)
  );
}

function matchesCorruptedNounOmittedTicketTemplate(normalizedContent: string) {
  return (
    TICKET_TEMPLATE_OMITTED_OPENING_PATTERN.test(normalizedContent) &&
    TICKET_TEMPLATE_CORRUPTED_SALE_PATTERN.test(normalizedContent)
  );
}

function matchesKnownTicketScamCampaign(normalizedContent: string) {
  return (
    TICKET_SALE_PATTERN.test(normalizedContent) &&
    UNABLE_TO_ATTEND_PATTERN.test(normalizedContent) &&
    TICKET_BUNDLE_PATTERN.test(normalizedContent) &&
    TICKET_TEMPLATE_RECIPIENT_PATTERN.test(normalizedContent) &&
    (matchesExplicitTicketTemplate(normalizedContent) ||
      matchesCorruptedNounOmittedTicketTemplate(normalizedContent))
  );
}

function matchesKnownTicketGiveawayCampaign(normalizedContent: string) {
  const matchesBrunoGiveawayCampaign =
    KNOWN_BRUNO_GIVEAWAY_EVENT_PATTERN.test(normalizedContent) &&
    GIVEAWAY_PATTERN.test(normalizedContent) &&
    KNOWN_BRUNO_GIVEAWAY_SCHEDULE_PATTERN.test(normalizedContent) &&
    KNOWN_BRUNO_GIVEAWAY_CONTACT_PATTERN.test(normalizedContent);
  const matchesFamilyResaleCampaign =
    KNOWN_FAMILY_RESALE_INTRO_PATTERN.test(normalizedContent) &&
    KNOWN_FAMILY_RESALE_EVENT_PATTERN.test(normalizedContent) &&
    KNOWN_FAMILY_RESALE_OPENING_PATTERN.test(normalizedContent) &&
    TICKET_SALE_PATTERN.test(normalizedContent) &&
    KNOWN_FAMILY_RESALE_STORY_PATTERN.test(normalizedContent) &&
    KNOWN_FAMILY_RESALE_VIEW_PATTERN.test(normalizedContent) &&
    KNOWN_FAMILY_RESALE_CONTACT_PATTERN.test(normalizedContent);

  return matchesBrunoGiveawayCampaign || matchesFamilyResaleCampaign;
}

function matchesCameraRetailListing(normalizedContent: string) {
  if (!CAMERA_DEVICE_PATTERN.test(normalizedContent)) {
    return false;
  }

  const detailCount = [
    CAMERA_BODY_DETAIL_PATTERN,
    CAMERA_SENSOR_DETAIL_PATTERN,
    CAMERA_VIDEO_DETAIL_PATTERN,
  ].filter((pattern) => pattern.test(normalizedContent)).length;
  const hasGearBundle = CAMERA_GEAR_BUNDLE_PATTERN.test(normalizedContent);

  return detailCount >= 2 || (hasGearBundle && detailCount >= 1);
}

function matchesKnownCameraGiveawayCampaign(normalizedContent: string) {
  const markerCount = KNOWN_CAMERA_GIVEAWAY_MARKER_PATTERNS.filter((pattern) =>
    pattern.test(normalizedContent),
  ).length;
  const matchesR7Campaign =
    KNOWN_CAMERA_GIVEAWAY_MODEL_PATTERN.test(normalizedContent) &&
    KNOWN_CAMERA_GIVEAWAY_RESOLUTION_PATTERN.test(normalizedContent) &&
    KNOWN_CAMERA_GIVEAWAY_SENSOR_PATTERN.test(normalizedContent) &&
    KNOWN_CAMERA_GIVEAWAY_EXTRA_LENS_PATTERN.test(normalizedContent) &&
    markerCount >= 2;
  const matchesUpgradeCampaign =
    KNOWN_CAMERA_UPGRADE_MODEL_PATTERN.test(normalizedContent) &&
    KNOWN_CAMERA_UPGRADE_STORY_PATTERN.test(normalizedContent) &&
    KNOWN_CAMERA_UPGRADE_CONDITION_PATTERN.test(normalizedContent) &&
    KNOWN_CAMERA_UPGRADE_AUDIENCE_PATTERN.test(normalizedContent) &&
    KNOWN_CAMERA_UPGRADE_PICKUP_PATTERN.test(normalizedContent);

  return matchesR7Campaign || matchesUpgradeCampaign;
}

function matchesTicketOffer(normalizedContent: string) {
  return (
    TICKET_ITEM_PATTERN.test(normalizedContent) &&
    (TICKET_SALE_PATTERN.test(normalizedContent) ||
      GIVEAWAY_PATTERN.test(normalizedContent))
  );
}

function matchesCameraDeviceOffer(normalizedContent: string) {
  if (!CAMERA_DEVICE_PATTERN.test(normalizedContent)) {
    return false;
  }

  const hasTechnicalDetails =
    (CAMERA_BODY_DETAIL_PATTERN.test(normalizedContent) &&
      !CAMERA_BODY_CAP_PATTERN.test(normalizedContent)) ||
    CAMERA_SENSOR_DETAIL_PATTERN.test(normalizedContent) ||
    CAMERA_VIDEO_DETAIL_PATTERN.test(normalizedContent);

  return (
    !CAMERA_ACCESSORY_ONLY_PATTERN.test(normalizedContent) ||
    hasTechnicalDetails
  );
}

const SIGNAL_RULES: readonly ScamSignalRule[] = [
  {
    id: 'broadcast_mention',
    matches: ({ mentionsEveryone }) => mentionsEveryone,
    points: 4,
  },
  {
    id: 'off_platform_contact',
    matches: ({ normalizedContent }) =>
      OFF_PLATFORM_CONTACT_PATTERN.test(normalizedContent),
    points: 4,
  },
  {
    id: 'phone_number',
    matches: ({ phoneNumberPresent }) => phoneNumberPresent,
    points: 3,
  },
  {
    id: 'direct_contact',
    matches: ({ normalizedContent }) =>
      DIRECT_CONTACT_PATTERN.test(normalizedContent),
    points: 3,
  },
  {
    id: 'urgency',
    matches: ({ normalizedContent }) => URGENCY_PATTERN.test(normalizedContent),
    points: 4,
  },
  {
    id: 'giveaway_lure',
    matches: ({ normalizedContent }) =>
      GIVEAWAY_PATTERN.test(normalizedContent),
    points: 4,
  },
  {
    id: 'high_value_item',
    matches: ({ normalizedContent }) =>
      HIGH_VALUE_ITEM_PATTERN.test(normalizedContent),
    points: 3,
  },
  {
    id: 'camera_listing_fingerprint',
    matches: ({ normalizedContent }) =>
      matchesCameraRetailListing(normalizedContent),
    points: 5,
  },
  {
    id: 'known_camera_giveaway_campaign',
    matches: ({ normalizedContent }) =>
      matchesKnownCameraGiveawayCampaign(normalizedContent),
    points: 3,
  },
  {
    id: 'replacement_story',
    matches: ({ normalizedContent }) =>
      REPLACEMENT_STORY_PATTERN.test(normalizedContent),
    points: 2,
  },
  {
    id: 'payment_request',
    matches: ({ normalizedContent }) =>
      PAYMENT_REQUEST_PATTERN.test(normalizedContent),
    points: 4,
  },
  {
    id: 'ticket_offer',
    matches: ({ normalizedContent }) => matchesTicketOffer(normalizedContent),
    points: 4,
  },
  {
    id: 'unable_to_attend_story',
    matches: ({ normalizedContent }) =>
      UNABLE_TO_ATTEND_PATTERN.test(normalizedContent),
    points: 3,
  },
  {
    id: 'ticket_bundle',
    matches: ({ normalizedContent }) =>
      TICKET_BUNDLE_PATTERN.test(normalizedContent),
    points: 2,
  },
  {
    id: 'ticket_template_fingerprint',
    matches: ({ normalizedContent }) =>
      matchesKnownTicketScamCampaign(normalizedContent),
    points: 6,
  },
  {
    id: 'known_ticket_scam_campaign',
    matches: ({ normalizedContent }) =>
      matchesKnownTicketGiveawayCampaign(normalizedContent),
    points: 6,
  },
  {
    id: 'new_account',
    matches: (context) =>
      isYoungerThan(
        context.accountCreatedTimestamp,
        context.observedAtTimestamp,
        NEW_ACCOUNT_AGE_MS,
      ),
    points: 2,
  },
  {
    id: 'new_server_member',
    matches: (context) =>
      isYoungerThan(
        context.joinedTimestamp,
        context.observedAtTimestamp,
        NEW_MEMBER_AGE_MS,
      ),
    points: 2,
  },
];

export function analyzeScamMessage(
  input: ScamDetectionInput,
): ScamDetectionResult {
  const boundedContent = input.content.slice(0, MAX_SCANNED_CONTENT_LENGTH);
  const normalizedContent = normalizeScamText(boundedContent);
  const context: DetectionContext = {
    ...input,
    content: boundedContent,
    normalizedContent,
    phoneNumberPresent: containsPhoneNumber(boundedContent),
  };
  const matchedRules = SIGNAL_RULES.filter((rule) => rule.matches(context));
  const signalIds = matchedRules.map(({ id }) => id);
  const score = matchedRules.reduce((total, { points }) => total + points, 0);
  const hasRequiredOffer = signalIds.includes('giveaway_lure');
  const hasHighValueItem = signalIds.includes('high_value_item');
  const hasTicketOffer = signalIds.includes('ticket_offer');
  const hasUnableToAttendStory = signalIds.includes('unable_to_attend_story');
  const hasTicketBundle = signalIds.includes('ticket_bundle');
  const hasTicketTemplateFingerprint = signalIds.includes(
    'ticket_template_fingerprint',
  );
  const hasKnownTicketScamCampaign = signalIds.includes(
    'known_ticket_scam_campaign',
  );
  const hasCameraListingFingerprint = signalIds.includes(
    'camera_listing_fingerprint',
  );
  const hasContact = signalIds.some((id) =>
    ['direct_contact', 'off_platform_contact', 'phone_number'].includes(id),
  );
  const hasPhoneNumber = signalIds.includes('phone_number');
  const hasCampaignDistribution = signalIds.some((id) =>
    ['broadcast_mention', 'off_platform_contact'].includes(id),
  );
  const hasStrongCorroboration = signalIds.some((id) =>
    [
      'broadcast_mention',
      'known_camera_giveaway_campaign',
      'new_account',
      'new_server_member',
      'off_platform_contact',
      'payment_request',
      'phone_number',
      'urgency',
    ].includes(id),
  );
  const isReportedScam = REPORTED_SCAM_CONTEXT_PATTERN.test(normalizedContent);
  const isTransparentFaceValueSale =
    FACE_VALUE_SALE_PATTERN.test(normalizedContent);
  const isGiveawayScam =
    hasRequiredOffer &&
    hasHighValueItem &&
    hasContact &&
    hasStrongCorroboration &&
    score >= 13;
  const isTicketTemplateScam =
    hasUnableToAttendStory &&
    hasTicketBundle &&
    hasTicketTemplateFingerprint &&
    hasContact &&
    score >= 17;
  const isKnownTicketCampaignScam =
    hasKnownTicketScamCampaign &&
    hasContact &&
    hasPhoneNumber &&
    hasCampaignDistribution &&
    score >= 17;
  const isSuspiciousTicketOffer =
    hasTicketOffer &&
    hasContact &&
    (hasUnableToAttendStory || hasRequiredOffer);
  const isSuspiciousCameraGiveaway =
    hasRequiredOffer &&
    matchesCameraDeviceOffer(normalizedContent) &&
    (hasContact || hasCameraListingFingerprint);
  const isNounOmittedTicketNearMatch =
    matchesNounOmittedTicketStructure(normalizedContent) && hasContact;
  const isActionableScam =
    isGiveawayScam || isTicketTemplateScam || isKnownTicketCampaignScam;
  const isLikelyScam =
    !isReportedScam && !isTransparentFaceValueSale && isActionableScam;

  return {
    isLikelyScam,
    requiresReview:
      !isLikelyScam &&
      (isActionableScam ||
        isSuspiciousCameraGiveaway ||
        isSuspiciousTicketOffer ||
        isNounOmittedTicketNearMatch),
    score,
    signalIds,
  };
}

export function normalizeScamText(content: string): string {
  const normalized = content
    .slice(0, MAX_SCANNED_CONTENT_LENGTH)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, '');
  const confusableFolded = [...normalized]
    .map((character) => CONFUSABLES.get(character) ?? character)
    .join('');

  return confusableFolded
    .replace(/[^a-z0-9@+]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_SCANNED_CONTENT_LENGTH);
}

function containsPhoneNumber(content: string): boolean {
  const normalized = content
    .normalize('NFKC')
    .slice(0, MAX_SCANNED_CONTENT_LENGTH);
  const candidates = normalized.match(/[+\d][\d\s().-]{8,28}\d/gu) ?? [];

  return candidates.some((candidate) => {
    const digitCount = (candidate.match(/\d/gu) ?? []).length;
    return digitCount >= 10 && digitCount <= 15;
  });
}

function isYoungerThan(
  timestamp: number | null,
  observedAtTimestamp: number,
  maximumAgeMs: number,
) {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return false;
  }

  const ageMs = observedAtTimestamp - timestamp;
  return ageMs >= 0 && ageMs < maximumAgeMs;
}
