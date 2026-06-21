/**
 * HTTP route for Discord interaction callbacks.
 *
 * This is the Worker-facing edge route Discord calls. It verifies signatures,
 * delegates to the interaction dispatcher, and always returns a Discord-shaped
 * response even when command code throws.
 */
import { handleDiscordInteraction } from '../discord/interactions';
import { genericInteractionError } from '../discord/responses';
import { verifyDiscordRequest } from '../discord/signature';
import type { Env } from '../discord/types';
import { jsonResponse } from '../utils/json';
import { createLogger } from '../utils/logger';

const logger = createLogger('discord-interactions');

export async function handleDiscordInteractionsRoute(
  request: Request,
  env: Env,
): Promise<Response> {
  // Discord requires signature verification against the exact raw body, so this
  // happens before any route code attempts to parse or otherwise consume it.
  const verification = await verifyDiscordRequest(request, env);

  if (!verification.ok) {
    return new Response(verification.message, { status: verification.status });
  }

  try {
    return jsonResponse(
      await handleDiscordInteraction(verification.interaction, env),
    );
  } catch (error) {
    // Interaction callbacks have a tight response window; log detail server-side
    // and give Discord a valid, friendly interaction response.
    logger.error('Failed to handle Discord interaction.', error);
    return jsonResponse(genericInteractionError());
  }
}
