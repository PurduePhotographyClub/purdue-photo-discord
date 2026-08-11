import type { ScamModerationAlert } from './scamModerationService.js';
import type {
  PendingReviewState,
  PendingScamReview,
} from './scamReviewTypes.js';

const REVIEW_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_PENDING_REVIEWS = 2_000;

export function registerPendingReview(
  entries: ReadonlyMap<string, PendingScamReview>,
  alert: ScamModerationAlert,
  alertMessageId: string,
  now: number,
) {
  const activeEntries = [...entries].filter(
    ([, entry]) => entry.expiresAt > now,
  );
  const boundedEntries =
    activeEntries.length >= MAX_PENDING_REVIEWS
      ? activeEntries
          .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
          .slice(activeEntries.length - MAX_PENDING_REVIEWS + 1)
      : activeEntries;

  return new Map([
    ...boundedEntries,
    [
      alert.messageId,
      {
        alert,
        alertMessageId,
        expiresAt: now + REVIEW_TTL_MS,
        state: 'pending',
      },
    ] as const,
  ]);
}

export function prunePendingReviews(
  entries: ReadonlyMap<string, PendingScamReview>,
  now: number,
) {
  return new Map([...entries].filter(([, entry]) => entry.expiresAt > now));
}

export function updatePendingReviewState(
  entries: ReadonlyMap<string, PendingScamReview>,
  reviewId: string,
  state: PendingReviewState,
) {
  return new Map(
    [...entries].map(([key, entry]) => [
      key,
      key === reviewId ? { ...entry, state } : entry,
    ]),
  );
}
