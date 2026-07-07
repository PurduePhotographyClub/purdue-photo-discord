/**
 * Worker-side client for Gateway HTTP APIs.
 *
 * New Gateway control endpoints should be added here so they all share endpoint
 * resolution, HMAC signing, response parsing, and Worker-friendly errors.
 */
import type { Env } from '../discord/types';
import { AppError, ConfigError } from '../utils/errors';
import { getGatewayServiceUrl, getWorkerSecret } from '../utils/env';
import { signInternalRequest } from '../utils/internalRequestSignature';
import { createLogger } from '../utils/logger';

export type GatewayPresenceStatus = 'dnd' | 'idle' | 'invisible' | 'online';

export interface GatewayPresenceUpdate {
  activityName?: string | null;
  activityType?: number;
  status?: GatewayPresenceStatus;
}

export interface GatewayPresenceSnapshot {
  activityName?: string;
  activityType?: number;
  ok: boolean;
  status: GatewayPresenceStatus;
  updatedAt: string;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type GatewayApiTransport = {
  fetcher: Fetcher;
  transport: 'vpc_service';
  url: string;
};

const SIGNATURE_HEADER = 'x-pccbot-signature';
const TIMESTAMP_HEADER = 'x-pccbot-timestamp';
const logger = createLogger('gateway-api');

export async function updateGatewayPresence(
  env: Env,
  update: GatewayPresenceUpdate,
): Promise<GatewayPresenceSnapshot> {
  // /status only needs this one endpoint today, but the lower helper is written
  // for more signed Gateway API calls later.
  const responseBody = await requestGatewayApi(env, '/presence', update);

  if (!isGatewayPresenceSnapshot(responseBody)) {
    logger.warn('Gateway returned invalid presence response.', {
      path: '/presence',
    });

    throw new AppError('Gateway returned an invalid presence response.', {
      code: 'GATEWAY_API_ERROR',
      details: responseBody,
      expose: true,
      status: 502,
    });
  }

  return responseBody;
}

async function requestGatewayApi(
  env: Env,
  path: string,
  body: unknown,
): Promise<unknown> {
  // All Worker-to-Gateway control APIs should go through this helper so they
  // get the same endpoint resolution, signing, and error handling.
  const transport = getGatewayApiTransport(env, path);

  const workerSecret = getWorkerSecret(env);

  if (!workerSecret) {
    throw new ConfigError('WORKER_SECRET is not configured.');
  }

  const method = 'POST';
  const requestBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = await signInternalRequest(
    workerSecret,
    method,
    path,
    timestamp,
    requestBody,
  );

  const startedAt = Date.now();
  let response: Response;

  try {
    response = await transport.fetcher(transport.url, {
      body: requestBody,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        [SIGNATURE_HEADER]: signature,
        [TIMESTAMP_HEADER]: timestamp,
      },
      method,
    });
  } catch (error) {
    logger.error('Gateway API request failed before response.', {
      error,
      latencyMs: Date.now() - startedAt,
      method,
      path,
      transport: transport.transport,
    });
    throw error;
  }

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    logger.warn('Gateway API request failed.', {
      latencyMs: Date.now() - startedAt,
      method,
      path,
      status: response.status,
      transport: transport.transport,
    });

    throw new AppError(`Gateway API request failed with ${response.status}.`, {
      code: 'GATEWAY_API_ERROR',
      details: responseBody,
      expose: true,
      status: 502,
    });
  }

  return responseBody;
}

function getGatewayApiTransport(env: Env, path: string): GatewayApiTransport {
  if (env.GATEWAY_SERVICE) {
    return {
      fetcher: (input, init) => env.GATEWAY_SERVICE!.fetch(input, init),
      transport: 'vpc_service',
      url: getGatewayServiceUrl(path),
    };
  }

  throw new ConfigError('GATEWAY_SERVICE VPC binding is not configured.');
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  // Gateway routes are JSON today, but empty responses are easier to debug as
  // undefined than as a JSON parse error.
  const text = await response.text();

  if (text.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isGatewayPresenceSnapshot(
  value: unknown,
): value is GatewayPresenceSnapshot {
  // Validate the small response contract before command code trusts it.
  return (
    isRecord(value) &&
    value.ok === true &&
    isGatewayPresenceStatus(value.status) &&
    typeof value.updatedAt === 'string'
  );
}

export function isGatewayPresenceStatus(
  value: unknown,
): value is GatewayPresenceStatus {
  // This mirrors Discord presence states supported by discord.js.
  return (
    value === 'dnd' ||
    value === 'idle' ||
    value === 'invisible' ||
    value === 'online'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // Common guard for parsed JSON objects; arrays are not valid response records.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
