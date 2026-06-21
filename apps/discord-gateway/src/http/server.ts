/**
 * Small HTTP server for Gateway-side routes.
 *
 * Keep this as the traffic cop. Route files should own auth, parsing, and actual
 * feature behavior.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { GatewayConfig, GatewayHttpServerConfig } from '../config.js';
import type { DiscordGatewayRunner } from '../discord/client.js';
import type { Logger } from '../utils/logger.js';
import { writeJson } from './responses.js';
import { handleHealthRequest } from './routes/health.js';
import { handlePresenceRequest } from './routes/presence.js';

export interface GatewayHttpServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createGatewayHttpServer(
  config: GatewayConfig,
  gateway: Pick<DiscordGatewayRunner, 'getHealth' | 'updatePresence'>,
  logger: Logger,
): GatewayHttpServer {
  // Public factory kept small so tests and the entrypoint do not need to know
  // about the Node server object.
  return createConfiguredHttpServer(config, gateway, logger);
}

function createConfiguredHttpServer(
  config: GatewayConfig,
  gateway: Pick<DiscordGatewayRunner, 'getHealth' | 'updatePresence'>,
  logger: Logger,
): GatewayHttpServer {
  // Track start state ourselves because Node's Server does not expose a simple
  // "already listening" promise-safe flag.
  let started = false;

  const server = createServer((request, response) => {
    void handleGatewayRequest(request, response, config, gateway, logger);
  });

  server.on('error', (error) => {
    logger.error('Gateway HTTP server error.', error);
  });

  return {
    async start() {
      // Make start idempotent so future supervisors/tests can call it safely.
      if (started) {
        return;
      }

      await listen(server, config.httpServer);
      started = true;

      logger.info('Gateway HTTP server is listening.', {
        host: config.httpServer.host,
        paths: ['/health', '/presence'],
        port: config.httpServer.port,
      });
    },

    async stop() {
      // Same idea as start(): stopping twice should be a no-op, not a noisy
      // shutdown error.
      if (!started) {
        return;
      }

      await close(server);
      started = false;
    },
  };
}

async function handleGatewayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: GatewayConfig,
  gateway: Pick<DiscordGatewayRunner, 'getHealth' | 'updatePresence'>,
  logger: Logger,
): Promise<void> {
  // Route by path only; the route modules handle methods and payload rules.
  const url = parseRequestUrl(request);

  if (!url) {
    writeJson(request, response, 404, { ok: false, error: 'Not found' });
    return;
  }

  if (url.pathname === '/health') {
    handleHealthRequest(request, response, gateway);
    return;
  }

  if (url.pathname === '/presence') {
    await handlePresenceRequest(request, response, config, gateway, logger);
    return;
  }

  writeJson(request, response, 404, { ok: false, error: 'Not found' });
}

function parseRequestUrl(request: IncomingMessage): URL | undefined {
  // IncomingMessage.url is a path, so provide a harmless base host for URL
  // parsing. We only use pathname for routing.
  if (!request.url) {
    return undefined;
  }

  return new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
}

function listen(
  server: Server,
  config: GatewayHttpServerConfig,
): Promise<void> {
  // Wrap listen() so the entrypoint can await a clean startup before logging
  // success.
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });
}

function close(server: Server): Promise<void> {
  // Node's close callback reports bind/shutdown errors; surface them to callers
  // instead of hiding them during deploy restarts.
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
