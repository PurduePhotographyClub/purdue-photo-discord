/**
 * Tiny response helpers for Gateway HTTP routes.
 *
 * Keeping JSON headers and 405 handling here avoids copy-paste across routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export function writeJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  // Health/control responses should not be cached by proxies or browsers; the
  // caller is asking for current process state.
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  response.end(JSON.stringify(body));
}

export function writeMethodNotAllowed(
  request: IncomingMessage,
  response: ServerResponse,
  allow: string,
): void {
  // Send the standard Allow header so curl and future clients can see what a
  // route expects.
  response.setHeader('allow', allow);
  writeJson(request, response, 405, {
    ok: false,
    error: 'Method not allowed',
  });
}
