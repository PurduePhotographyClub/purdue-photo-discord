import type { Env } from '../discord/types';
import { ConfigError, UnauthorizedError } from '../utils/errors';
import { getOptionalEnv, getWorkerSecret } from '../utils/env';
import { createLogger } from '../utils/logger';

const SIGNATURE_HEADER = 'x-pccbot-signature';
const TIMESTAMP_HEADER = 'x-pccbot-timestamp';
const NONCE_HEADER = 'x-pccbot-nonce';
const SIGNATURE_PREFIX = 'sha256=';
const MAX_CLOCK_SKEW_MS = 60_000;
const NONCE_TTL_SECONDS = 120;
const NONCE_STORE_TIMEOUT_MS = 2_000;
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
    hasNonceStore: Boolean(env.REQUEST_NONCES),
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
  const nonceStore = env.REQUEST_NONCES;
  if (!nonceStore) {
    if (shouldUseLocalNonceFallback(env)) {
      assertUnusedLocalNonce(nonce);
      return;
    }

    throw new ConfigError('REQUEST_NONCES KV binding is not configured.');
  }

  try {
    await assertUnusedStoredNonce(nonceStore, nonce);
    return;
  } catch (error) {
    if (error instanceof ConfigError && shouldUseLocalNonceFallback(env)) {
      logger.warn(
        'REQUEST_NONCES KV unavailable in local development; using in-memory nonce fallback.',
        { reason: error.message },
      );
      assertUnusedLocalNonce(nonce);
      return;
    }

    throw error;
  }
}

async function assertUnusedStoredNonce(
  nonceStore: KVNamespace,
  nonce: string,
): Promise<void> {
  const key = `gateway:${nonce}`;
  logger.debug('Checking gateway request nonce store.', {
    nonceLength: nonce.length,
    ttlSeconds: NONCE_TTL_SECONDS,
  });

  if (await withNonceStoreTimeout(nonceStore.get(key), 'read')) {
    throw new UnauthorizedError('Gateway request nonce was already used.');
  }

  await withNonceStoreTimeout(
    nonceStore.put(key, '1', { expirationTtl: NONCE_TTL_SECONDS }),
    'write',
  );
  logger.debug('Stored gateway request nonce.');
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

async function withNonceStoreTimeout<T>(
  operation: Promise<T>,
  operationName: 'read' | 'write',
): Promise<T> {
  let didTimeOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      didTimeOut = true;
      reject(new ConfigError(`REQUEST_NONCES KV ${operationName} timed out.`));
    }, NONCE_STORE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    logger.error(`REQUEST_NONCES KV ${operationName} failed.`, error);
    throw new ConfigError(`REQUEST_NONCES KV ${operationName} failed.`);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    if (didTimeOut) {
      operation.catch((error) => {
        logger.error(
          `REQUEST_NONCES KV ${operationName} failed after timeout.`,
          error,
        );
      });
    }
  }
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
