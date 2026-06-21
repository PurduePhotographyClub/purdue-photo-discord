/**
 * JSON helpers for Worker routes.
 *
 * Routes use these to keep response headers, exposed errors, and request parsing
 * consistent across Discord, health, and internal endpoints.
 */
import { BadRequestError, isAppError } from './errors';

const JSON_CONTENT_TYPE = 'application/json;charset=UTF-8';
const API_VERSION = '1';

interface ReadJsonOptions {
  maxBytes?: number;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  // Preserve caller-supplied headers but default to JSON.
  const headers = new Headers(init.headers);

  setDefaultHeader(headers, 'content-type', JSON_CONTENT_TYPE);
  setDefaultHeader(headers, 'cache-control', 'no-store');
  setDefaultHeader(headers, 'x-api-version', API_VERSION);
  setDefaultHeader(headers, 'x-content-type-options', 'nosniff');

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function errorJsonResponse(error: unknown): Response {
  if (isAppError(error)) {
    // Only errors marked as expose=true can send their message to callers; all
    // other failures use a generic response but keep their specific status/code.
    return jsonResponse(
      {
        success: false,
        error: {
          code: error.code,
          message: error.expose ? error.message : 'Internal server error',
        },
      },
      { status: error.status },
    );
  }

  return jsonResponse(
    {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    },
    { status: 500 },
  );
}

export async function readJson<T = unknown>(
  request: Request,
  options: ReadJsonOptions = {},
): Promise<T> {
  // Read as text first so empty bodies and invalid JSON get friendly errors.
  const body = await readRequestText(request, options);

  if (body.trim().length === 0) {
    throw new BadRequestError('Request body must contain JSON.');
  }

  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new BadRequestError('Request body must be valid JSON.', {
      cause: error instanceof Error ? error.message : 'Unknown parse error',
    });
  }
}

async function readRequestText(
  request: Request,
  options: ReadJsonOptions,
): Promise<string> {
  if (options.maxBytes === undefined) {
    return request.text();
  }

  const contentLength = readContentLength(
    request.headers.get('content-length'),
  );
  if (contentLength !== null && contentLength > options.maxBytes) {
    throw new BadRequestError('Request body is too large.');
  }

  const body = await request.arrayBuffer();

  if (body.byteLength > options.maxBytes) {
    throw new BadRequestError('Request body is too large.');
  }

  return new TextDecoder().decode(body);
}

function setDefaultHeader(headers: Headers, name: string, value: string): void {
  if (!headers.has(name)) {
    headers.set(name, value);
  }
}

function readContentLength(value: string | null) {
  if (!value) {
    return null;
  }

  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) && parsedValue >= 0
    ? parsedValue
    : null;
}
