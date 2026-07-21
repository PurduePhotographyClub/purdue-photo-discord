/**
 * Executive command that posts the PPC equipment terms accept/deny message.
 */
import type { DiscordCommand } from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { postEquipmentTermsMessage } from '../../services/discordEquipmentLoanService';
import { requestWebsiteApi } from '../../services/websiteApiService';
import { AppError, getErrorMessage } from '../../utils/errors';

export const equipmentTermsMessageCommand: DiscordCommand = {
  definition: {
    description: 'Post the equipment loan terms accept/deny message.',
    name: 'equipment-terms-message',
  },
  execute: async (interaction, env) => {
    const discordId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!discordId) {
      return ephemeralResponse('Could not identify your Discord user ID.');
    }

    try {
      const access = await requestWebsiteApi(
        env,
        '/service-managers/access-by-discord',
        {
          body: { discordId, scope: 'equipment' },
          method: 'POST',
        },
      );
      if (!isAllowedAccessResponse(access)) {
        return ephemeralResponse(
          'You are not authorized to post the equipment terms message.',
        );
      }

      const result = await postEquipmentTermsMessage(env);

      return ephemeralResponse(
        `Equipment terms message posted in <#${result.channelId}>${result.messageId ? ` as ${result.messageId}` : ''}.`,
      );
    } catch (error) {
      if (isAccessDeniedError(error)) {
        return ephemeralResponse(
          'You are not authorized to post the equipment terms message.',
        );
      }
      return ephemeralResponse(
        `Could not post equipment terms message: ${getErrorMessage(error)}`,
      );
    }
  },
};

function isAllowedAccessResponse(value: unknown) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { allowed?: unknown }).allowed === true
  );
}

function isAccessDeniedError(error: unknown) {
  return (
    error instanceof AppError &&
    typeof error.details === 'object' &&
    error.details !== null &&
    !Array.isArray(error.details) &&
    (error.details as { allowed?: unknown }).allowed === false
  );
}
