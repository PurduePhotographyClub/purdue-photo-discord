export type ScamSignalId =
  | 'broadcast_mention'
  | 'direct_contact'
  | 'giveaway_lure'
  | 'high_value_item'
  | 'new_account'
  | 'new_server_member'
  | 'off_platform_contact'
  | 'payment_request'
  | 'phone_number'
  | 'replacement_story'
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
  /\b(?:give|giving|gave)\s+(?:it\s+)?(?:away|out)\b|\b(?:want\s+to\s+give|donat(?:e|ing)|handing\s+out)\b|\b(?:for\s+free|free\s+of\s+charge)\b|\bf\s*r\s*e\s*e\s+giveaway\b/u;
const DIRECT_CONTACT_PATTERN =
  /\b(?:d\s*m|direct\s+message|private\s+message|message|contact|inbox)\s+(?:me|if\s+(?:you\s+are\s+)?interested)\b|\bd\s*m\s+if\b/u;
const OFF_PLATFORM_CONTACT_PATTERN =
  /\b(?:whats\s*app|telegram|signal\s+app|kik)\b|\bwa\s+me\b/u;
const URGENCY_PATTERN =
  /\b(?:strictly\s+)?first\s+come\s+first\s+serve(?:d)?\b|\b(?:act\s+fast|hurry|today\s+only|limited\s+time)\b/u;
const HIGH_VALUE_ITEM_PATTERN =
  /\b(?:mac\s*book|iphone|ipad|laptop|playstation|ps\s*5|xbox|camera|dslr|mirrorless|canon(?:\s+eos)?|nikon(?:\s+z)?|sony(?:\s+(?:alpha|a\s*\d))?|fuji(?:film)?|leica|hasselblad|gopro|drone|lens(?:es)?)\b/u;
const REPLACEMENT_STORY_PATTERN =
  /\b(?:just\s+got|got|bought)\s+(?:myself\s+)?a\s+new\b|\b(?:new\s+model|because\s+i\s+upgraded|since\s+i\s+upgraded|perfect\s+(?:health|condition)|good\s+as\s+new|cannot\s+afford|can\s+not\s+afford|can\s+t\s+afford|in\s+need\s+of)\b/u;
const PAYMENT_REQUEST_PATTERN =
  /\b(?:shipping|delivery|courier|insurance|processing)\s+fee\b|\bpay\s+(?:only\s+)?(?:for\s+)?(?:shipping|postage|delivery)\b|\b(?:cash\s*app|zelle|venmo|gift\s+card|crypto(?:currency)?)\b/u;
const REPORTED_SCAM_CONTEXT_PATTERN =
  /\b(?:scam\s+warning|reporting\s+(?:a|this)\s+scam|this\s+(?:message|post)\s+is\s+a\s+scam|do\s+not\s+d\s*m\s+this\s+person)\b/u;

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
  const hasContact = signalIds.some((id) =>
    ['direct_contact', 'off_platform_contact', 'phone_number'].includes(id),
  );
  const hasStrongCorroboration = signalIds.some((id) =>
    [
      'broadcast_mention',
      'new_account',
      'new_server_member',
      'off_platform_contact',
      'payment_request',
      'phone_number',
      'urgency',
    ].includes(id),
  );
  const isReportedScam = REPORTED_SCAM_CONTEXT_PATTERN.test(normalizedContent);

  return {
    isLikelyScam:
      !isReportedScam &&
      hasRequiredOffer &&
      hasHighValueItem &&
      hasContact &&
      hasStrongCorroboration &&
      score >= 13,
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
