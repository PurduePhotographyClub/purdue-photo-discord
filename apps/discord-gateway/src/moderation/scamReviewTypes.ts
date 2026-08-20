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
    | 'restored'
    | 'reviewed'
    | 'unavailable';
}

export type PendingReviewState =
  'pending' | 'processing' | 'restored' | 'reviewed';

export interface PendingScamReview {
  alert: ScamModerationAlert;
  alertMessageId: string;
  expiresAt: number;
  state: PendingReviewState;
}
