/**
 * Gateway process entrypoint.
 *
 * Starts config, Discord, event forwarding, and the local HTTP API. systemd
 * restarts are cleaner if both Discord and HTTP get a chance to shut down.
 */
import { readGatewayConfig } from './config.js';
import { createDiscordGatewayRunner } from './discord/client.js';
import { WorkerEventForwarder } from './discord/forwarder.js';
import {
  createGatewayHttpServer,
  type GatewayHttpServer,
} from './http/server.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('gateway');
let httpServer: GatewayHttpServer | undefined;

try {
  const config = readGatewayConfig();
  const forwarder = new WorkerEventForwarder(config, logger);
  const gateway = createDiscordGatewayRunner(config, forwarder, logger);
  httpServer = createGatewayHttpServer(config, gateway, logger);

  // systemd sends SIGTERM during normal restarts; SIGINT keeps local development
  // shutdowns equally tidy.
  process.once('SIGINT', () => {
    logger.info('Received SIGINT. Stopping Gateway forwarder.');
    gateway.stop();
    void httpServer?.stop();
  });

  process.once('SIGTERM', () => {
    logger.info('Received SIGTERM. Stopping Gateway forwarder.');
    gateway.stop();
    void httpServer?.stop();
  });

  await httpServer?.start();
  await gateway.start();
} catch (error) {
  logger.error('Gateway forwarder failed to start.', error);
  await httpServer?.stop();
  process.exitCode = 1;
}
