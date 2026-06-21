/**
 * Builders for Discord interaction callback payloads.
 *
 * Discord expects a specific response envelope. These helpers keep command code
 * focused on message content instead of response type constants.
 */
import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import type {
  DiscordInteractionResponse,
  DiscordMessagePayload,
} from './types';

export function pongResponse(): DiscordInteractionResponse {
  // Discord sends PING during endpoint validation and expects PONG.
  return {
    type: InteractionResponseType.PONG,
  };
}

export function messageResponse(
  message: string | DiscordMessagePayload,
  options: { ephemeral?: boolean } = {},
): DiscordInteractionResponse {
  // Accept either plain text or a full payload so commands can stay concise.
  const data: DiscordMessagePayload =
    typeof message === 'string' ? { content: message } : { ...message };

  if (options.ephemeral) {
    data.flags = Number(data.flags ?? 0) | InteractionResponseFlags.EPHEMERAL;
  }

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data,
  };
}

export function ephemeralResponse(
  message: string | DiscordMessagePayload,
): DiscordInteractionResponse {
  // Most bot replies are operational, so default to caller-only visibility.
  return messageResponse(message, { ephemeral: true });
}

export function genericInteractionError(): DiscordInteractionResponse {
  // Keep user-facing errors bland; logs carry the real details.
  return ephemeralResponse(
    'Something went wrong while handling that interaction.',
  );
}
