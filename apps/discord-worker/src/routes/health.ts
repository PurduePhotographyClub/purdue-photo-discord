/**
 * Public Worker health route.
 *
 * This reports configuration state only. It should never echo raw secret values,
 * tokens, or full internal URLs back to callers.
 */
import type { Env } from '../discord/types';
import {
  getOptionalEnv,
  getOptionalUrlEnv,
  hasWorkerSecret,
} from '../utils/env';
import { jsonResponse } from '../utils/json';

export function handleWorkerHealthRoute(_request: Request, env: Env): Response {
  // Booleans/status labels are enough for deploy checks and do not leak config.
  return jsonResponse({
    ok: true,
    service: 'pccbot-discord',
    configuration: {
      discordApplicationId: Boolean(
        getOptionalEnv(env, 'DISCORD_APPLICATION_ID'),
      ),
      discordGuildId: Boolean(getOptionalEnv(env, 'DISCORD_GUILD_ID')),
      discordPublicKey: Boolean(getOptionalEnv(env, 'DISCORD_PUBLIC_KEY')),
      apiWorker: Boolean(env.API_WORKER),
      nonceReplayProtection: Boolean(env.API_WORKER),
      workerSecret: hasWorkerSecret(env),
      websiteUrl: getOptionalUrlEnv(env, 'WEBSITE_URL').status,
      wikiUrl: getOptionalUrlEnv(env, 'WIKI_URL').status,
      gatewayService: Boolean(env.GATEWAY_SERVICE),
    },
  });
}
