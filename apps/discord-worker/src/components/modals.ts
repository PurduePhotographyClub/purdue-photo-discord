/**
 * Modal submit entrypoint.
 *
 * Modal routes will land here once the bot has forms. Until then, unknown modal
 * submissions get a friendly response and stay out of the generic error path.
 */
import type {
  DiscordInteractionResponse,
  Env,
  ModalSubmitInteraction,
} from '../discord/types';
import { ephemeralResponse } from '../discord/responses';
import {
  handleFilmRequestReviewModalSubmit,
  isFilmRequestReviewModalCustomId,
} from '../services/discordFilmRequestService';
import {
  handleStudioModalSubmit,
  isStudioModalCustomId,
} from '../services/discordStudioScheduleService';
import {
  handleMemberReportCorrectionModalSubmit,
  handleMemberReportModalSubmit,
  isMemberReportCorrectionModalCustomId,
  isMemberReportModalCustomId,
} from '../services/discordMemberReportService';
import {
  handleEventCarpoolModalSubmit,
  isEventCarpoolModalCustomId,
} from '../services/discordEventCarpoolService';

export async function handleModalSubmitInteraction(
  interaction: ModalSubmitInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  if (isMemberReportModalCustomId(interaction.data.custom_id)) {
    return handleMemberReportModalSubmit(interaction, env);
  }

  if (isMemberReportCorrectionModalCustomId(interaction.data.custom_id)) {
    return handleMemberReportCorrectionModalSubmit(interaction, env);
  }

  if (isFilmRequestReviewModalCustomId(interaction.data.custom_id)) {
    return handleFilmRequestReviewModalSubmit(interaction, env);
  }

  if (isStudioModalCustomId(interaction.data.custom_id)) {
    return handleStudioModalSubmit(interaction, env);
  }

  if (isEventCarpoolModalCustomId(interaction.data.custom_id)) {
    return handleEventCarpoolModalSubmit(interaction, env);
  }

  // Discord expects an interaction response even for unsupported custom IDs.
  return ephemeralResponse(
    `That modal is not handled yet: ${interaction.data.custom_id}`,
  );
}
