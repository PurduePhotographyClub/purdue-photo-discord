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
import type {
  DiscordInteraction,
  DiscordInteractionResponse,
  Env,
} from '../discord/types';
import { jsonResponse } from '../utils/json';
import { createLogger } from '../utils/logger';
import {
  isDarkroomScheduleDropCustomId,
  isDarkroomScheduleJoinSelectCustomId,
  isDarkroomScheduleSessionActionCustomId,
} from '../services/discordDarkroomScheduleService';
import {
  isEquipmentLoanActionButtonCustomId,
  isEquipmentTermsButtonCustomId,
} from '../services/discordEquipmentLoanService';
import { isFilmRequestReviewModalCustomId } from '../services/discordFilmRequestService';
import {
  isStudioDirectCancelButtonCustomId,
  isStudioModalCustomId,
} from '../services/discordStudioScheduleService';
import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
} from 'discord-interactions';

const logger = createLogger('discord-interactions');

export async function handleDiscordInteractionsRoute(
  request: Request,
  env: Env,
  context?: ExecutionContext,
): Promise<Response> {
  // Discord requires signature verification against the exact raw body, so this
  // happens before any route code attempts to parse or otherwise consume it.
  const verification = await verifyDiscordRequest(request, env);

  if (!verification.ok) {
    return new Response(verification.message, { status: verification.status });
  }

  try {
    if (
      context &&
      verification.interaction.application_id &&
      verification.interaction.token &&
      shouldDeferDiscordInteraction(verification.interaction)
    ) {
      return jsonResponse(
        deferDiscordInteraction(verification.interaction, env, context),
      );
    }

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

export function shouldDeferDiscordInteraction(interaction: DiscordInteraction) {
  if (
    interaction.type === InteractionType.APPLICATION_COMMAND &&
    interaction.data &&
    'name' in interaction.data
  ) {
    return (
      interaction.data.name === 'studio-message' ||
      interaction.data.name === 'darkroom-stats' ||
      interaction.data.name === 'equipment-terms-message'
    );
  }

  if (
    interaction.type === InteractionType.MODAL_SUBMIT &&
    interaction.data &&
    'custom_id' in interaction.data &&
    typeof interaction.data.custom_id === 'string'
  ) {
    return (
      isStudioModalCustomId(interaction.data.custom_id) ||
      isFilmRequestReviewModalCustomId(interaction.data.custom_id)
    );
  }

  if (
    interaction.type !== InteractionType.MESSAGE_COMPONENT ||
    !interaction.data ||
    !('custom_id' in interaction.data) ||
    typeof interaction.data.custom_id !== 'string'
  ) {
    return false;
  }

  const customId = interaction.data.custom_id;
  return (
    isDarkroomScheduleDropCustomId(customId) ||
    isDarkroomScheduleJoinSelectCustomId(customId) ||
    isDarkroomScheduleSessionActionCustomId(customId) ||
    isEquipmentTermsButtonCustomId(customId) ||
    isEquipmentLoanActionButtonCustomId(customId) ||
    isStudioDirectCancelButtonCustomId(customId)
  );
}

export function deferDiscordInteraction(
  interaction: DiscordInteraction,
  env: Env,
  context: ExecutionContext,
): DiscordInteractionResponse {
  context.waitUntil(completeDeferredInteraction(interaction, env));

  return {
    data: { flags: InteractionResponseFlags.EPHEMERAL },
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}

async function completeDeferredInteraction(
  interaction: DiscordInteraction,
  env: Env,
) {
  let response: DiscordInteractionResponse;
  try {
    response = await handleDiscordInteraction(interaction, env);
  } catch (error) {
    logger.error('Failed to handle deferred Discord interaction.', error);
    response = genericInteractionError();
  }

  try {
    await editOriginalInteractionResponse(interaction, response);
  } catch (error) {
    logger.error('Failed to complete deferred Discord interaction.', error);
  }
}

async function editOriginalInteractionResponse(
  interaction: DiscordInteraction,
  response: DiscordInteractionResponse,
) {
  if (!interaction.application_id || !interaction.token) {
    throw new Error('Deferred Discord interaction credentials are missing.');
  }

  const data = response.data ?? genericInteractionError().data ?? {};
  const result = await fetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
    {
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        ...(data.components ? { components: data.components } : {}),
        ...(data.content ? { content: data.content } : {}),
        ...(data.embeds ? { embeds: data.embeds } : {}),
      }),
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      method: 'PATCH',
    },
  );

  if (!result.ok) {
    throw new Error(
      `Deferred Discord response failed with status ${result.status}.`,
    );
  }
}
