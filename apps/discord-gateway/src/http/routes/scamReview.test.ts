import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScamReviewRequest } from './scamReview.js';

test('parses the narrow signed scam review control payload', () => {
  assert.deepEqual(
    parseScamReviewRequest({
      action: 'dismiss',
      actorId: '1063962284386439199',
      alertMessageId: '1536065199889584209',
      reviewId: '1535080862603808808',
    }),
    {
      action: 'dismiss',
      actorId: '1063962284386439199',
      alertMessageId: '1536065199889584209',
      reviewId: '1535080862603808808',
    },
  );
});

test('rejects malformed actions and Discord IDs', () => {
  assert.throws(
    () =>
      parseScamReviewRequest({
        action: 'ban',
        actorId: '1063962284386439199',
        alertMessageId: '1536065199889584209',
        reviewId: '1535080862603808808',
      }),
    /action is invalid/u,
  );
  assert.throws(
    () =>
      parseScamReviewRequest({
        action: 'dismiss',
        actorId: 'not-a-user',
        alertMessageId: '1536065199889584209',
        reviewId: '1535080862603808808',
      }),
    /actorId is invalid/u,
  );
});
