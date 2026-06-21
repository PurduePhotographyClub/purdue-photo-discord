/**
 * Select-menu interaction entrypoint.
 *
 * This keeps select handling separate from buttons and modals so component
 * custom IDs can grow independently.
 */
import type {
  ComponentInteraction,
  DiscordInteractionResponse,
  Env,
} from '../discord/types';
import { ephemeralResponse } from '../discord/responses';
import {
  handleDarkroomScheduleJoinSelect,
  isDarkroomScheduleJoinSelectCustomId,
} from '../services/discordDarkroomScheduleService';

export async function handleSelectInteraction(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  if (isDarkroomScheduleJoinSelectCustomId(interaction.data.custom_id)) {
    return handleDarkroomScheduleJoinSelect(interaction, env);
  }

  // Unknown select menus should be visible to the caller, not logged as crashes.
  return ephemeralResponse(
    `That select menu is not handled yet: ${interaction.data.custom_id}`,
  );
}
