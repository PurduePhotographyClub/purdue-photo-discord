/**
 * Executive command that posts the public honeypot warning message.
 */
import type { DiscordCommand } from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { postDiscordHoneypotWarningMessage } from '../../services/discordHoneypotService';
import { getErrorMessage } from '../../utils/errors';
import { getExecutiveRoleError } from './permissions';

export const honeypotWarningCommand: DiscordCommand = {
  definition: {
    description: 'Post the Discord honeypot warning message.',
    name: 'post-honeypot-warning',
  },
  execute: async (interaction, env) => {
    const permissionError = getExecutiveRoleError(interaction, env);

    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    try {
      const result = await postDiscordHoneypotWarningMessage(env);
      return ephemeralResponse(
        `Honeypot warning posted in <#${result.channelId}>${
          result.messageId ? ` as ${result.messageId}` : ''
        }.`,
      );
    } catch (error) {
      return ephemeralResponse(
        `Could not post honeypot warning: ${getErrorMessage(error)}`,
      );
    }
  },
};
