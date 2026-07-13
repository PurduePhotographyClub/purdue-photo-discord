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

  return parseJsonText<T>(body);
}

export function parseJsonText<T = unknown>(body: string): T {
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

export async function readRequestText(
  request: Request,
  options: ReadJsonOptions = {},
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

  if (request.body === null) {
    return '';
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bodyLength = 0;

  // Stop consuming an unknown-length stream as soon as it crosses the limit;
  // never materialize an unbounded ArrayBuffer before validation.
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value.byteLength > options.maxBytes - bodyLength) {
        await reader.cancel('Request body is too large.');
        throw new BadRequestError('Request body is too large.');
      }

      chunks.push(value);
      bodyLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bodyLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
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
