import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayConfig } from '../../config.js';
import type { DiscordGatewayRunner } from '../../discord/client.js';
import type { DiscordScamReviewRequest } from '../../moderation/scamReviewTypes.js';
import type { Logger } from '../../utils/logger.js';
import { isSignedGatewayRequest } from '../auth.js';
import { writeJson, writeMethodNotAllowed } from '../responses.js';

export async function handleScamReviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: GatewayConfig,
  gateway: Pick<DiscordGatewayRunner, 'reviewScam'>,
  logger: Logger,
): Promise<void> {
  if (request.method !== 'POST') {
    writeMethodNotAllowed(request, response, 'POST');
    return;
  }

  try {
    const rawBody = await readRequestBody(request);
    if (
      !isSignedGatewayRequest(request, {
        body: rawBody,
        path: '/scam-review',
        secret: config.workerSecret,
      })
    ) {
      writeJson(request, response, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    const review = parseScamReviewRequest(parseJsonBody(rawBody));
    const result = await gateway.reviewScam(review);
    writeJson(request, response, 200, result);
  } catch (error) {
    if (error instanceof ScamReviewRequestError) {
      writeJson(request, response, error.status, {
        ok: false,
        error: error.message,
      });
      return;
    }

    logger.error('Failed to resolve a Discord scam review.', error);
    writeJson(request, response, 500, {
      ok: false,
      error: 'Failed to resolve scam review',
    });
  }
}

export function parseScamReviewRequest(
  value: unknown,
): DiscordScamReviewRequest {
  if (!isRecord(value)) {
    throw new ScamReviewRequestError('Scam review must be an object.', 400);
  }
  if (
    value.action !== 'confirm' &&
    value.action !== 'dismiss' &&
    value.action !== 'reviewed'
  ) {
    throw new ScamReviewRequestError('Scam review action is invalid.', 400);
  }
  const actorId = value.actorId;
  const alertMessageId = value.alertMessageId;
  const reviewId = value.reviewId;
  for (const [field, fieldValue] of [
    ['actorId', actorId],
    ['alertMessageId', alertMessageId],
    ['reviewId', reviewId],
  ] as const) {
    if (!isSnowflake(fieldValue)) {
      throw new ScamReviewRequestError(`Scam review ${field} is invalid.`, 400);
    }
  }

  return {
    action: value.action,
    actorId: actorId as string,
    alertMessageId: alertMessageId as string,
    reviewId: reviewId as string,
  };
}

async function readRequestBody(request: IncomingMessage) {
  let body = '';
  for await (const chunk of request) {
    body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (body.length > 4_096) {
      throw new ScamReviewRequestError('Request body is too large.', 413);
    }
  }
  return body;
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ScamReviewRequestError('Request body must be valid JSON.', 400);
  }
}

function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class ScamReviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ScamReviewRequestError';
  }
}
