import { ephemeralResponse } from '../../discord/responses';
import type { DiscordCommand } from '../../discord/types';
import { postMemberReportPanel } from '../../services/discordMemberReportService';
import { getErrorMessage } from '../../utils/errors';
import { getExecutiveRoleError } from './permissions';

export const postReportMessageCommand: DiscordCommand = {
  definition: {
    description: 'Post the anonymous member report panel.',
    name: 'post-report-message',
  },
  execute: async (interaction, env) => {
    const permissionError = getExecutiveRoleError(interaction, env);
    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    try {
      const result = await postMemberReportPanel(env, interaction.channel_id);
      return ephemeralResponse(
        `Report message posted in <#${result.channelId}>${
          result.messageId ? ` as ${result.messageId}` : ''
        }.`,
      );
    } catch (error) {
      return ephemeralResponse(
        `Could not post report message: ${getErrorMessage(error)}`,
      );
    }
  },
};
