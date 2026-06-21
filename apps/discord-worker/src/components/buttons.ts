/**
 * Button interaction entrypoint.
 *
 * No buttons are wired yet, but keeping the handler in place means new button
 * components can be added without changing the main Discord dispatcher.
 */
import type {
  ComponentInteraction,
  DiscordInteractionResponse,
  Env,
} from '../discord/types';
import { ephemeralResponse } from '../discord/responses';
import {
  DISCORD_VERIFY_BUTTON_CUSTOM_ID,
  handleDiscordVerifyButton,
} from '../services/discordVerificationService';
import {
  handleWikiGuideButton,
  isWikiGuideButtonCustomId,
} from '../commands/general/wiki';
import {
  handleDarkroomScheduleDropButton,
  handleDarkroomScheduleSessionActionButton,
  isDarkroomScheduleDropCustomId,
  isDarkroomScheduleSessionActionCustomId,
} from '../services/discordDarkroomScheduleService';
import {
  handleEquipmentLoanActionButton,
  handleEquipmentTermsButton,
  isEquipmentLoanActionButtonCustomId,
  isEquipmentTermsButtonCustomId,
} from '../services/discordEquipmentLoanService';
import {
  handleFilmRequestReviewButton,
  isFilmRequestReviewButtonCustomId,
} from '../services/discordFilmRequestService';
import {
  handleStudioCancelButton,
  handleStudioReviewButton,
  handleStudioScheduleBookButton,
  isStudioCancelButtonCustomId,
  isStudioReviewButtonCustomId,
  isStudioScheduleBookCustomId,
} from '../services/discordStudioScheduleService';

export async function handleButtonInteraction(
  interaction: ComponentInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  if (interaction.data.custom_id === DISCORD_VERIFY_BUTTON_CUSTOM_ID) {
    return handleDiscordVerifyButton(interaction, env);
  }

  if (isWikiGuideButtonCustomId(interaction.data.custom_id)) {
    return handleWikiGuideButton(interaction, env);
  }

  if (isDarkroomScheduleDropCustomId(interaction.data.custom_id)) {
    return handleDarkroomScheduleDropButton(interaction, env);
  }

  if (isDarkroomScheduleSessionActionCustomId(interaction.data.custom_id)) {
    return handleDarkroomScheduleSessionActionButton(interaction, env);
  }

  if (isFilmRequestReviewButtonCustomId(interaction.data.custom_id)) {
    return handleFilmRequestReviewButton(interaction);
  }

  if (isEquipmentTermsButtonCustomId(interaction.data.custom_id)) {
    return handleEquipmentTermsButton(interaction, env);
  }

  if (isEquipmentLoanActionButtonCustomId(interaction.data.custom_id)) {
    return handleEquipmentLoanActionButton(interaction, env);
  }

  if (isStudioScheduleBookCustomId(interaction.data.custom_id)) {
    return handleStudioScheduleBookButton();
  }

  if (isStudioCancelButtonCustomId(interaction.data.custom_id)) {
    return handleStudioCancelButton(interaction, env);
  }

  if (isStudioReviewButtonCustomId(interaction.data.custom_id)) {
    return handleStudioReviewButton(interaction);
  }

  // Return a valid interaction response instead of letting unknown buttons time
  // out in Discord.
  return ephemeralResponse(
    `That button is not handled yet: ${interaction.data.custom_id}`,
  );
}
