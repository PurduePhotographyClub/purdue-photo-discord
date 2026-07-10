import type { Env } from '../discord/types';
import { claimGatewayRequestNonce } from '../services/websiteApiService';
import { ConfigError, UnauthorizedError } from '../utils/errors';
import { getOptionalEnv, getWorkerSecret } from '../utils/env';
import { createLogger } from '../utils/logger';

const SIGNATURE_HEADER = 'x-pccbot-signature';
const TIMESTAMP_HEADER = 'x-pccbot-timestamp';
const NONCE_HEADER = 'x-pccbot-nonce';
const SIGNATURE_PREFIX = 'sha256=';
const MAX_CLOCK_SKEW_MS = 60_000;
const NONCE_TTL_SECONDS = 120;
const MAX_NONCE_LENGTH = 128;
const LOCAL_NONCE_FALLBACK_ENVIRONMENTS = new Set([
  'dev',
  'development',
  'local',
]);
const logger = createLogger('gateway-auth');
const localNonceExpirations = new Map<string, number>();

export async function authorizeGatewayRequest(
  request: Request,
  env: Env,
): Promise<void> {
  const url = new URL(request.url);
  logger.debug('Authorizing gateway request.', {
    hasNonce: request.headers.has(NONCE_HEADER),
    hasNonceClaimRoute: Boolean(env.API_WORKER),
    hasSignature: request.headers.has(SIGNATURE_HEADER),
    hasTimestamp: request.headers.has(TIMESTAMP_HEADER),
    hasWorkerSecret: Boolean(getWorkerSecret(env)),
    method: request.method,
    path: `${url.pathname}${url.search}`,
  });

  await verifyGatewaySignature(request, env);
  logger.info('Gateway request authorized successfully.', {
    method: request.method,
    path: `${url.pathname}${url.search}`,
  });
}

async function verifyGatewaySignature(
  request: Request,
  env: Env,
): Promise<void> {
  const secret = getWorkerSecret(env);
  if (!secret) {
    throw new ConfigError('WORKER_SECRET is not configured.');
  }

  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const nonce = request.headers.get(NONCE_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (
    !timestamp ||
    !nonce ||
    !signature ||
    !isFreshTimestamp(timestamp) ||
    !isValidNonce(nonce)
  ) {
    throw new UnauthorizedError(
      'Gateway request signature headers are invalid.',
    );
  }

  const body = await request.clone().text();
  const url = new URL(request.url);
  const expectedSignature = await signGatewayRequest({
    body,
    method: request.method,
    nonce,
    path: `${url.pathname}${url.search}`,
    secret,
    timestamp,
  });

  if (!safeEqual(signature, expectedSignature)) {
    throw new UnauthorizedError('Gateway request signature did not match.');
  }

  await assertUnusedNonce(env, nonce);
  logger.debug('Gateway request signature verified successfully.');
}

async function assertUnusedNonce(env: Env, nonce: string): Promise<void> {
  if (!env.API_WORKER && shouldUseLocalNonceFallback(env)) {
    logger.warn(
      'API Worker unavailable in local development; using in-memory nonce fallback.',
    );
    assertUnusedLocalNonce(nonce);
    return;
  }

  const claimed = await claimGatewayRequestNonce(env, nonce);
  if (!claimed) {
    throw new UnauthorizedError('Gateway request nonce was already used.');
  }

  logger.debug('Claimed gateway request nonce through the API Worker.', {
    nonceLength: nonce.length,
    ttlSeconds: NONCE_TTL_SECONDS,
  });
}

function assertUnusedLocalNonce(nonce: string): void {
  const now = Date.now();
  const key = `gateway:${nonce}`;
  cleanupLocalNonces(now);

  const expiresAt = localNonceExpirations.get(key);
  if (expiresAt !== undefined && expiresAt > now) {
    throw new UnauthorizedError('Gateway request nonce was already used.');
  }

  localNonceExpirations.set(key, now + NONCE_TTL_SECONDS * 1_000);
  logger.debug('Stored gateway request nonce in local development fallback.', {
    nonceLength: nonce.length,
    ttlSeconds: NONCE_TTL_SECONDS,
  });
}

function cleanupLocalNonces(now: number): void {
  for (const [key, expiresAt] of localNonceExpirations) {
    if (expiresAt <= now) {
      localNonceExpirations.delete(key);
    }
  }
}

function shouldUseLocalNonceFallback(env: Env): boolean {
  const environment = getOptionalEnv(env, 'ENVIRONMENT')?.toLowerCase();

  return (
    environment !== undefined &&
    LOCAL_NONCE_FALLBACK_ENVIRONMENTS.has(environment)
  );
}

async function signGatewayRequest(options: {
  body: string;
  method: string;
  nonce: string;
  path: string;
  secret: string;
  timestamp: string;
}) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(options.secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(
      [
        options.method.toUpperCase(),
        options.path,
        options.timestamp,
        options.nonce,
        options.body,
      ].join('\n'),
    ),
  );

  return `${SIGNATURE_PREFIX}${toHex(signature)}`;
}

function isFreshTimestamp(timestamp: string) {
  const parsed = Number(timestamp);
  return (
    Number.isFinite(parsed) &&
    Math.abs(Date.now() - parsed) <= MAX_CLOCK_SKEW_MS
  );
}

function isValidNonce(nonce: string) {
  return nonce.length > 0 && nonce.length <= MAX_NONCE_LENGTH;
}

function safeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    diff |= leftBytes[index]! ^ rightBytes[index]!;
  }

  return diff === 0;
}

function toHex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
