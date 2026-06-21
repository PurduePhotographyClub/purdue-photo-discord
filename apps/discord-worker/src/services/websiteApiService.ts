/**
 * Client for Discord Worker -> PPC API Worker calls.
 *
 * Discord-to-API communication is intentionally private: every request uses the
 * API_WORKER service binding and carries internal authentication headers.
 */
import type { Env } from '../discord/types';
import { getOptionalEnv } from '../utils/env';
import { AppError, ConfigError } from '../utils/errors';
import { createLogger } from '../utils/logger';

interface WebsiteApiRequestOptions {
  body?: unknown;
  method?: WebsiteApiMethod;
}

interface WebsiteApiFetchResult {
  response: Response;
  transport: 'service_binding';
}

type WebsiteApiMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

const INTERNAL_SOURCE_HEADER = 'x-pcc-internal-source';
const INTERNAL_TOKEN_HEADER = 'x-internal-token';
const API_PREFIX = '/api';
const API_V1_PREFIX = '/api/v1';
const DISCORD_WORKER_SOURCE = 'discord-worker';
const logger = createLogger('website-api');

export async function requestWebsiteApi(
  env: Env,
  path: string,
  options: WebsiteApiRequestOptions = {},
): Promise<unknown> {
  const method =
    options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const normalizedPath = normalizeApiPath(path);
  const init = createApiRequestInit(env, method, body);
  if (body) {
    init.body = body;
  }

  const startedAt = Date.now();
  let fetchResult: WebsiteApiFetchResult;

  try {
    fetchResult = await fetchApiWorker(env, normalizedPath, init);
  } catch (error) {
    logger.error('Website API request failed before response.', {
      error,
      latencyMs: Date.now() - startedAt,
      method,
      path: normalizedPath,
    });
    throw error;
  }

  const { response, transport } = fetchResult;
  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    logger.warn('Website API request failed.', {
      latencyMs: Date.now() - startedAt,
      method,
      path: normalizedPath,
      status: response.status,
      transport,
    });

    throw new AppError(`Website API request failed with ${response.status}.`, {
      code: 'WEBSITE_API_ERROR',
      details: responseBody,
      expose: true,
      status: 502,
    });
  }

  return responseBody;
}

function createApiRequestInit(
  env: Env,
  method: WebsiteApiMethod,
  body: string,
): RequestInit {
  const headers = new Headers();
  headers.set(INTERNAL_SOURCE_HEADER, DISCORD_WORKER_SOURCE);

  if (body) {
    headers.set('content-type', 'application/json;charset=UTF-8');
  }

  const token = getOptionalEnv(env, 'INTERNAL_TOKEN');
  if (token) {
    headers.set(INTERNAL_TOKEN_HEADER, token);
  }

  return {
    headers,
    method,
  };
}

async function fetchApiWorker(
  env: Env,
  normalizedPath: string,
  init: RequestInit,
): Promise<WebsiteApiFetchResult> {
  const request = new Request(
    new URL(normalizedPath, 'https://api.internal'),
    init,
  );
  if (env.API_WORKER) {
    return {
      response: await env.API_WORKER.fetch(request),
      transport: 'service_binding',
    };
  }

  throw new ConfigError('API_WORKER service binding is not configured.');
}

function normalizeApiPath(path: string) {
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  if (
    trimmedPath === API_V1_PREFIX ||
    trimmedPath.startsWith(`${API_V1_PREFIX}/`)
  ) {
    return trimmedPath;
  }

  if (trimmedPath === API_PREFIX) {
    return API_V1_PREFIX;
  }

  if (trimmedPath.startsWith(`${API_PREFIX}/`)) {
    return `${API_V1_PREFIX}${trimmedPath.slice(API_PREFIX.length)}`;
  }

  return `${API_V1_PREFIX}${trimmedPath}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
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
