import type { DiscordCommand } from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { postJobs101Messages } from '../../services/discordJobsAccessService';
import { getErrorMessage } from '../../utils/errors';
import { getExecutiveRoleError } from './permissions';

export const jobs101MessageCommand: DiscordCommand = {
  definition: {
    description: 'Post Jobs 101 and its access acknowledgement.',
    name: 'jobs-101-message',
  },
  execute: async (interaction, env) => {
    const permissionError = getExecutiveRoleError(interaction, env);

    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    try {
      const result = await postJobs101Messages(env);
      return ephemeralResponse(
        `Jobs 101 posted in <#${result.channelId}> as ${result.messageIds.length} messages.`,
      );
    } catch (error) {
      return ephemeralResponse(
        `Could not post Jobs 101: ${getErrorMessage(error)}`,
      );
    }
  },
};
