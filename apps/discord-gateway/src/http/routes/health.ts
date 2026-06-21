/**
 * Public health check for the Gateway process.
 *
 * This stays unauthenticated on purpose. It answers "is the VPS Gateway alive?"
 * without exposing any control surface.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DiscordGatewayRunner } from '../../discord/client.js';
import { writeJson, writeMethodNotAllowed } from '../responses.js';

export function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  gateway: Pick<DiscordGatewayRunner, 'getHealth'>,
): void {
  // Support HEAD because the Worker health command only needs status/latency.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeMethodNotAllowed(request, response, 'GET, HEAD');
    return;
  }

  const health = gateway.getHealth();
  // A non-ready Discord websocket should show as 503 even if the HTTP process is
  // still alive.
  writeJson(request, response, health.ok ? 200 : 503, health);
}
