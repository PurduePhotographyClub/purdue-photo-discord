/**
 * Executive command that posts the interactive wiki guide message.
 */
import type { DiscordCommand } from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { postWikiGuideMessage } from '../general/wiki';
import { getErrorMessage } from '../../utils/errors';
import { getExecutiveRoleError } from './permissions';

export const wikiMessageCommand: DiscordCommand = {
  definition: {
    description: 'Post the interactive PPC wiki guide message.',
    name: 'wiki-message',
  },
  execute: async (interaction, env) => {
    const permissionError = getExecutiveRoleError(interaction, env);

    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    try {
      const result = await postWikiGuideMessage(env);
      return ephemeralResponse(
        `Wiki message posted${result.channelId ? ` in <#${result.channelId}>` : ''}${result.messageId ? ` as ${result.messageId}` : ''}.`,
      );
    } catch (error) {
      return ephemeralResponse(
        `Could not post wiki message: ${getErrorMessage(error)}`,
      );
    }
  },
};
