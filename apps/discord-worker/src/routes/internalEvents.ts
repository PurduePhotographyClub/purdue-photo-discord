/**
 * Authenticated internal event route.
 *
 * Website automations and the VPS Gateway use this endpoint to ask the Worker
 * to send Discord messages or handle sanitized Gateway events.
 */
import { dispatchInternalEvent } from '../internal-events/dispatcher';
import { parseInternalEvent } from '../internal-events/parser';
import { authorizeGatewayRequest } from '../http/gatewayRequestAuth';
import type { Env } from '../discord/types';
import type { ParsedInternalEvent } from '../internal-events/types';
import { isAppError } from '../utils/errors';
import { errorJsonResponse, jsonResponse, readJson } from '../utils/json';
import { createLogger } from '../utils/logger';

const INTERNAL_EVENT_BODY_LIMIT_BYTES = 64 * 1_024;
const logger = createLogger('internal-events');

interface RequestLogContext {
  method: string;
  path: string;
  requestId: string;
}

export async function handleInternalEventsRoute(
  request: Request,
  env: Env,
  context?: ExecutionContext,
): Promise<Response> {
  const startedAt = Date.now();
  const requestLog = createRequestLogContext(request);

  try {
    return await handleInternalEventsRequest(
      request,
      env,
      context,
      requestLog,
      startedAt,
    );
  } catch (error) {
    if (isAppError(error) && error.status < 500) {
      logger.warn('Rejected internal event request.', {
        code: error.code,
        latencyMs: Date.now() - startedAt,
        ...requestLog,
        status: error.status,
      });
    } else {
      logger.error('Failed to handle internal event request.', {
        error,
        latencyMs: Date.now() - startedAt,
        ...requestLog,
      });
    }

    return errorJsonResponse(error);
  }
}

async function handleInternalEventsRequest(
  request: Request,
  env: Env,
  context: ExecutionContext | undefined,
  requestLog: RequestLogContext,
  startedAt: number,
): Promise<Response> {
  const authRequest = request.clone();
  await authorizeGatewayRequest(authRequest, env);

  const parsedEvent = parseInternalEvent(
    await readJson(request, {
      maxBytes: INTERNAL_EVENT_BODY_LIMIT_BYTES,
    }),
  );

  logger.info('Received internal event.', {
    ...requestLog,
    ...getInternalEventLogContext(parsedEvent),
  });

  const responseBody = await dispatchInternalEvent(parsedEvent, env, context);
  logger.info('Handled internal event.', {
    ...requestLog,
    ...getInternalEventLogContext(parsedEvent),
    latencyMs: Date.now() - startedAt,
    status: 200,
  });

  return jsonResponse(responseBody);
}

function createRequestLogContext(request: Request): RequestLogContext {
  const url = new URL(request.url);

  return {
    method: request.method,
    path: `${url.pathname}${url.search}`,
    requestId: crypto.randomUUID(),
  };
}

function getInternalEventLogContext(
  parsedEvent: ParsedInternalEvent,
): Record<string, unknown> {
  if (parsedEvent.kind === 'gateway') {
    return {
      channelId: parsedEvent.event.channelId,
      eventType: parsedEvent.event.eventType,
      guildId: parsedEvent.event.guildId,
      kind: parsedEvent.kind,
      messageId: parsedEvent.event.messageId,
      type: parsedEvent.event.type,
      userId: parsedEvent.event.userId,
    };
  }

  if (parsedEvent.kind === 'message') {
    return {
      channelId: parsedEvent.event.channelId,
      kind: parsedEvent.kind,
      messageId: parsedEvent.event.messageId,
      type: parsedEvent.event.type,
    };
  }

  if (parsedEvent.kind === 'memberRoles') {
    return {
      discordId: parsedEvent.event.discordId,
      kind: parsedEvent.kind,
      type: parsedEvent.event.type,
    };
  }

  if (parsedEvent.kind === 'scheduledEvent') {
    return {
      discordEventId: parsedEvent.event.discordEventId,
      kind: parsedEvent.kind,
      type: parsedEvent.event.type,
    };
  }

  if (parsedEvent.kind === 'darkroomSchedule') {
    return {
      channelId: parsedEvent.event.channelId,
      kind: parsedEvent.kind,
      slotId: parsedEvent.event.slotId,
      type: parsedEvent.event.type,
    };
  }

  if (parsedEvent.kind === 'darkroomStats') {
    return {
      kind: parsedEvent.kind,
      messageId: parsedEvent.event.messageId,
      type: parsedEvent.event.type,
      userCount: parsedEvent.event.userCount,
    };
  }

  if (parsedEvent.kind === 'studioSchedule') {
    return {
      channelId: parsedEvent.event.channelId,
      kind: parsedEvent.kind,
      requestId: parsedEvent.event.requestId,
      type: parsedEvent.event.type,
    };
  }

  if (parsedEvent.kind === 'studioScheduleMessage') {
    return {
      channelId: parsedEvent.event.channelId,
      kind: parsedEvent.kind,
      messageId: parsedEvent.event.messageId,
      type: parsedEvent.event.type,
    };
  }

  if (parsedEvent.kind === 'studioPendingReview') {
    return {
      channelId: parsedEvent.event.channelId,
      kind: parsedEvent.kind,
      messageId: parsedEvent.event.messageId,
      requestId: parsedEvent.event.requestId,
      type: parsedEvent.event.type,
    };
  }

  return {
    kind: parsedEvent.kind,
    type: parsedEvent.event.type,
  };
}
