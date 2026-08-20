import { DISCORD_CHANNEL_IDS } from '../config/discord-channel-ids';
import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import { ephemeralResponse } from '../discord/responses';
import type {
  ComponentInteraction,
  DiscordInteractionResponse,
  Env,
} from '../discord/types';
import {
  reviewGatewayScam,
  type GatewayScamReviewRequest,
} from './gatewayApiService';

const CUSTOM_ID_PATTERN =
  /^scam-review:(confirm|dismiss|reviewed):(\d{17,20})$/u;

export function isDiscordScamReviewButtonCustomId(customId: string) {
  return CUSTOM_ID_PATTERN.test(customId);
}

export async function handleDiscordScamReviewButton(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  const parsed = parseCustomId(interaction.data.custom_id);
  if (!parsed) {
    return ephemeralResponse('That scam review button is invalid.');
  }
  if (!env.DISCORD_GUILD_ID || interaction.guild_id !== env.DISCORD_GUILD_ID) {
    return ephemeralResponse('That scam review belongs to another server.');
  }
  if (interaction.channel_id !== DISCORD_CHANNEL_IDS.scamAlerts) {
    return ephemeralResponse(
      'Scam review actions only work in the private alert channel.',
    );
  }

  const actorId = interaction.member?.user?.id;
  const alertMessageId = interaction.message?.id;
  if (!isSnowflake(actorId) || !isSnowflake(alertMessageId)) {
    return ephemeralResponse('Discord did not include enough review context.');
  }

  const roles = interaction.member?.roles ?? [];
  if (
    !roles.includes(DISCORD_ROLE_IDS.admin) &&
    !roles.includes(DISCORD_ROLE_IDS.executive)
  ) {
    return ephemeralResponse(
      'Only Discord Admin or Executive members can resolve scam reviews.',
    );
  }

  try {
    const result = await reviewGatewayScam(env, {
      action: parsed.action,
      actorId,
      alertMessageId,
      reviewId: parsed.reviewId,
    });
    return ephemeralResponse(result.message);
  } catch {
    return ephemeralResponse(
      'I could not reach the scam moderator. Try again in a moment.',
    );
  }
}

function parseCustomId(
  customId: string,
): Pick<GatewayScamReviewRequest, 'action' | 'reviewId'> | null {
  const match = CUSTOM_ID_PATTERN.exec(customId);
  if (!match) {
    return null;
  }
  return {
    action: match[1] as GatewayScamReviewRequest['action'],
    reviewId: match[2]!,
  };
}

function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/u.test(value);
}
