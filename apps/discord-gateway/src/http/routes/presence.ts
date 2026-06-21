/**
 * Changes Discord presence from a signed Worker request.
 *
 * The Worker does the Discord-role check. The Gateway still verifies the request
 * signature and validates the payload because this is a separate HTTP boundary.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayConfig, GatewayPresenceStatus } from '../../config.js';
import type {
  DiscordGatewayPresenceUpdate,
  DiscordGatewayRunner,
} from '../../discord/client.js';
import type { Logger } from '../../utils/logger.js';
import { isSignedGatewayRequest } from '../auth.js';
import { writeJson, writeMethodNotAllowed } from '../responses.js';

export async function handlePresenceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: GatewayConfig,
  gateway: Pick<DiscordGatewayRunner, 'updatePresence'>,
  logger: Logger,
): Promise<void> {
  // Presence is a control route, so only the Worker should POST here.
  if (request.method !== 'POST') {
    writeMethodNotAllowed(request, response, 'POST');
    return;
  }

  try {
    // Signature verification needs the raw string, not parsed JSON.
    const rawBody = await readRequestBody(request);

    if (
      !isSignedGatewayRequest(request, {
        body: rawBody,
        path: '/presence',
        secret: config.workerSecret,
      })
    ) {
      writeJson(request, response, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    const body = parseJsonBody(rawBody);
    const update = parsePresenceUpdate(body);
    const presence = gateway.updatePresence(update);

    writeJson(request, response, 200, presence);
  } catch (error) {
    if (error instanceof RequestError) {
      writeJson(request, response, error.status, {
        ok: false,
        error: error.message,
      });
      return;
    }

    logger.error('Failed to update Discord Gateway presence.', error);
    writeJson(request, response, 500, {
      ok: false,
      error: 'Failed to update presence',
    });
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  // Read the raw body once. It is used for both HMAC verification and JSON
  // parsing, and the small size cap keeps accidental large posts cheap to reject.
  let body = '';

  for await (const chunk of request) {
    body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    if (body.length > 4_096) {
      throw new RequestError('Request body is too large.', 413);
    }
  }

  return body;
}

function parseJsonBody(body: string): unknown {
  // Keep JSON errors user-readable for the Worker logs.
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RequestError('Request body must be valid JSON.', 400);
  }
}

function parsePresenceUpdate(value: unknown): DiscordGatewayPresenceUpdate {
  // Validate after signature verification because only signed callers should get
  // detailed shape errors from this route.
  if (!isRecord(value)) {
    throw new RequestError('Presence update must be an object.', 400);
  }

  // Be strict here even though the Worker already shapes command input.
  const update: DiscordGatewayPresenceUpdate = {};

  if ('status' in value) {
    if (!isGatewayPresenceStatus(value.status)) {
      throw new RequestError('Presence status is invalid.', 400);
    }

    update.status = value.status;
  }

  if ('activityName' in value) {
    if (value.activityName !== null && typeof value.activityName !== 'string') {
      throw new RequestError('Presence activityName is invalid.', 400);
    }

    update.activityName =
      value.activityName === null ? null : value.activityName.trim();
  }

  if ('activityType' in value) {
    if (
      typeof value.activityType !== 'number' ||
      !Number.isInteger(value.activityType) ||
      !isSupportedActivityType(value.activityType)
    ) {
      throw new RequestError('Presence activityType is invalid.', 400);
    }

    update.activityType = value.activityType;
  }

  if (Object.keys(update).length === 0) {
    throw new RequestError('Presence update is empty.', 400);
  }

  return update;
}

function isGatewayPresenceStatus(
  value: unknown,
): value is GatewayPresenceStatus {
  // Keep this in the route so HTTP input validation does not leak into the
  // Discord client module.
  return (
    value === 'dnd' ||
    value === 'idle' ||
    value === 'invisible' ||
    value === 'online'
  );
}

function isSupportedActivityType(value: number): boolean {
  // Limit to the activity types exposed by the slash command today.
  return value === 0 || value === 2 || value === 3 || value === 5;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // JSON arrays are objects in JavaScript, but the API body must be a keyed
  // object like { status: "idle" }.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    // Carry the HTTP status next to the message so the handler can keep all
    // expected client errors in one catch block.
    super(message);
    this.name = 'RequestError';
  }
}
