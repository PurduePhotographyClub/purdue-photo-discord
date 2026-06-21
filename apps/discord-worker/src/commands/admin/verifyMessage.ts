/**
 * Executive command that posts the public Discord verification button.
 */
import type { DiscordCommand } from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { postDiscordVerificationMessage } from '../../services/discordVerificationService';
import { getErrorMessage } from '../../utils/errors';
import { getExecutiveRoleError } from './permissions';

export const verifyMessageCommand: DiscordCommand = {
  definition: {
    description: 'Post the Discord verification message.',
    name: 'verify-message',
  },
  execute: async (interaction, env) => {
    const permissionError = getExecutiveRoleError(interaction, env);

    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    try {
      const result = await postDiscordVerificationMessage(env);
      return ephemeralResponse(
        `Verification message posted in <#${result.channelId}>${result.messageId ? ` as ${result.messageId}` : ''}.`,
      );
    } catch (error) {
      return ephemeralResponse(
        `Could not post verification message: ${getErrorMessage(error)}`,
      );
    }
  },
};
