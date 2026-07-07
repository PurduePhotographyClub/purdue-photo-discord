/**
 * Worker-side behavior for sanitized Discord Gateway events.
 *
 * The VPS Gateway forwards events here after filtering and normalizing IDs. This
 * service is where actual bot automation rules should live.
 */
import type { GatewayInternalEvent } from '@pccbot/shared';
import type { Env } from '../discord/types';
import { createLogger } from '../utils/logger';
import { handlePhotographerRequestReaction } from './photographerRequestStatusService';
import { addDiscordUnverifiedRole } from './discordMemberRoleService';
import { handleDiscordHoneypotMessage } from './discordHoneypotService';

export interface GatewayEventResult {
  handled: boolean;
}

const logger = createLogger('gateway-events');

export async function handleGatewayEvent(
  event: GatewayInternalEvent,
  env: Env,
): Promise<GatewayEventResult> {
  // Log normalized IDs from the forwarding boundary, not the whole Discord
  // payload, to keep observability useful without storing unnecessary data.
  logger.info('Received Discord Gateway event.', {
    channelId: event.channelId,
    emoji: readEmojiName(event.payload),
    eventType: event.eventType,
    guildId: event.guildId,
    messageId: event.messageId,
    userId: event.userId,
  });

  const photographerRequestResult = await handlePhotographerRequestReaction(
    event,
    env,
  );
  if (photographerRequestResult.handled) {
    return photographerRequestResult;
  }

  const honeypotResult = await handleDiscordHoneypotMessage(event, env);
  if (honeypotResult.handled) {
    return honeypotResult;
  }

  if (event.eventType === 'GUILD_MEMBER_ADD' && event.userId) {
    await addDiscordUnverifiedRole(env, event.userId);
    return { handled: true };
  }

  return { handled: false };
}

function readEmojiName(payload: Record<string, unknown>): string | undefined {
  // Reaction events nest emoji data; unknown payload shapes should just miss the
  // rule instead of throwing.
  const emoji = payload.emoji;

  if (!isRecord(emoji)) {
    return undefined;
  }

  return typeof emoji.name === 'string' ? emoji.name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // Guard nested event payload fields before reading them.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
