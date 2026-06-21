/**
 * Executive command that posts the PPC equipment terms accept/deny message.
 */
import type { DiscordCommand } from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { postEquipmentTermsMessage } from '../../services/discordEquipmentLoanService';
import { getErrorMessage } from '../../utils/errors';
import { getExecutiveRoleError } from './permissions';

export const equipmentTermsMessageCommand: DiscordCommand = {
  definition: {
    description: 'Post the equipment loan terms accept/deny message.',
    name: 'equipment-terms-message',
  },
  execute: async (interaction, env) => {
    const permissionError = getExecutiveRoleError(interaction, env);

    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    try {
      const result = await postEquipmentTermsMessage(env);

      return ephemeralResponse(
        `Equipment terms message posted in <#${result.channelId}>${result.messageId ? ` as ${result.messageId}` : ''}.`,
      );
    } catch (error) {
      return ephemeralResponse(
        `Could not post equipment terms message: ${getErrorMessage(error)}`,
      );
    }
  },
};
