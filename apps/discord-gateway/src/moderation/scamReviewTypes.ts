import type { ScamReviewAction } from './scamModerationAlert.js';
import type { ScamModerationAlert } from './scamModerationService.js';

export interface DiscordScamReviewRequest {
  action: ScamReviewAction;
  actorId: string;
  alertMessageId: string;
  reviewId: string;
}

export interface DiscordScamReviewResult {
  message: string;
  ok: boolean;
  status:
    | 'already_resolved'
    | 'expired'
    | 'forbidden'
    | 'dismissed'
    | 'reviewed'
    | 'unavailable';
}

export type PendingReviewState =
  'dismissed' | 'pending' | 'processing' | 'reviewed';

export interface PendingScamReview {
  alert: ScamModerationAlert;
  alertMessageId: string;
  expiresAt: number;
  state: PendingReviewState;
}
