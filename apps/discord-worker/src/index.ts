/**
 * Cloudflare Worker entrypoint.
 *
 * Route setup lives here so the auth model is visible at the edge: public
 * health, signed Discord interactions, and shared-secret internal events.
 */
import { AutoRouter } from 'itty-router';
import { handleDiscordInteractionsRoute } from './routes/discordInteractions';
import { handleWorkerHealthRoute } from './routes/health';
import { handleInternalEventsRoute } from './routes/internalEvents';
import type { Env } from './discord/types';
import { errorJsonResponse } from './utils/json';
import { createLogger } from './utils/logger';

const logger = createLogger('worker');
const router = AutoRouter();

// Keep public health checks, signed Discord callbacks, and internal automation
// ingress on separate routes so auth expectations stay obvious at the edge.
router.get('/', handleWorkerHealthRoute);
router.get('/health', handleWorkerHealthRoute);
router.post('/', handleDiscordInteractionsRoute);
router.post('/discord/interactions', handleDiscordInteractionsRoute);
router.post('/internal/events', handleInternalEventsRoute);
router.all('*', () => new Response('Not Found.', { status: 404 }));

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    // itty-router passes env/context through to each route handler.
    try {
      return await router.fetch(request, env, context);
    } catch (error) {
      // Last-resort guard for route bugs. Route-level code should throw AppError
      // when it wants a specific status, and unknown failures stay opaque.
      logger.error('Unhandled worker error.', error);
      return errorJsonResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;
