/**
 * Checks signed Worker-to-Gateway API calls.
 *
 * We do not send WORKER_SECRET as a bearer token. The Worker signs the
 * body, path, method, and timestamp; the Gateway recomputes that signature.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const SIGNATURE_HEADER = 'x-pccbot-signature';
const TIMESTAMP_HEADER = 'x-pccbot-timestamp';
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export function isSignedGatewayRequest(
  request: IncomingMessage,
  options: {
    body: string;
    path: string;
    secret: string;
  },
): boolean {
  // The route passes the already-read body so the signature covers exactly what
  // will be parsed and applied.
  const timestamp = getHeader(request, TIMESTAMP_HEADER);
  const signature = getHeader(request, SIGNATURE_HEADER);

  // Missing or stale auth data is a fast no. The timestamp limits replayed
  // requests if someone captures a signed call.
  if (!timestamp || !signature || !isFreshTimestamp(timestamp)) {
    return false;
  }

  const expectedSignature = signGatewayRequest({
    body: options.body,
    method: request.method ?? '',
    path: options.path,
    secret: options.secret,
    timestamp,
  });

  return safeEqual(signature, expectedSignature);
}

function signGatewayRequest(options: {
  body: string;
  method: string;
  path: string;
  secret: string;
  timestamp: string;
}): string {
  // Keep this private to the verifier. The Worker has the matching signer in its
  // gateway API service.
  const digest = createHmac('sha256', options.secret)
    .update(
      // This exact order is shared with the Worker signer.
      [
        options.method.toUpperCase(),
        options.path,
        options.timestamp,
        options.body,
      ].join('\n'),
    )
    .digest('hex');

  return `sha256=${digest}`;
}

function isFreshTimestamp(timestamp: string): boolean {
  // A small skew window is enough for normal Worker/VPS clock drift while making
  // captured requests age out quickly.
  const parsed = Number(timestamp);

  return (
    Number.isFinite(parsed) &&
    Math.abs(Date.now() - parsed) <= MAX_CLOCK_SKEW_MS
  );
}

function getHeader(
  request: IncomingMessage,
  headerName: string,
): string | undefined {
  // Node can expose repeated headers as arrays; these auth headers should be
  // single values, so arrays are treated as missing.
  const value = request.headers[headerName];

  return typeof value === 'string' ? value : undefined;
}

function safeEqual(left: string, right: string): boolean {
  // timingSafeEqual throws when lengths differ, so check length first while still
  // using constant-time comparison for same-sized signatures.
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
