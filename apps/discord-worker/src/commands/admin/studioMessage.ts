/**
 * Executive command that posts or updates the public studio scheduling message.
 */
import type { DiscordCommand } from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { requestWebsiteApi } from '../../services/websiteApiService';
import { getErrorMessage } from '../../utils/errors';
import { getExecutiveRoleError } from './permissions';

interface StudioMessageApiResponse {
  channelId?: unknown;
  messageId?: unknown;
  ok?: unknown;
}

export const studioMessageCommand: DiscordCommand = {
  definition: {
    description: 'Post or update the studio scheduling message.',
    name: 'studio-message',
  },
  execute: async (interaction, env) => {
    const permissionError = getExecutiveRoleError(interaction, env);

    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    try {
      const response = await requestWebsiteApi(
        env,
        '/admin/studio/schedule-message',
        { method: 'POST' },
      );
      const result = readStudioMessageApiResponse(response);

      return ephemeralResponse(
        `Studio scheduling message synced${result.channelId ? ` in <#${result.channelId}>` : ''}${result.messageId ? ` as ${result.messageId}` : ''}.`,
      );
    } catch (error) {
      return ephemeralResponse(
        `Could not sync studio scheduling message: ${getErrorMessage(error)}`,
      );
    }
  },
};

function readStudioMessageApiResponse(value: unknown): {
  channelId: string | null;
  messageId: string | null;
} {
  if (!isRecord(value)) {
    return { channelId: null, messageId: null };
  }

  const response = value as StudioMessageApiResponse;

  return {
    channelId:
      typeof response.channelId === 'string' ? response.channelId : null,
    messageId:
      typeof response.messageId === 'string' ? response.messageId : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
