/**
 * Executive command for syncing the darkroom stats Discord surfaces.
 */
import type {
  DiscordCommand,
  DiscordMessagePayload,
} from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { requestWebsiteApi } from '../../services/websiteApiService';
import { getErrorMessage } from '../../utils/errors';

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

interface DarkroomStatsSyncApiResponse {
  discordMemberCount?: unknown;
  ok?: unknown;
  rollCount?: unknown;
  userCount?: unknown;
  voiceChannelName?: unknown;
}

interface DarkroomStatsSyncResult {
  discordMemberCount: number | null;
  ok: boolean;
  rollCount: number;
  userCount: number;
  voiceChannelName: string | null;
}

export const darkroomStatsCommand: DiscordCommand = {
  definition: {
    description: 'Sync the darkroom stats message and Discord user count.',
    name: 'darkroom-stats',
  },
  execute: async (interaction, env) => {
    const discordId = getInteractionUserId(interaction);
    if (!discordId) {
      return ephemeralResponse('Could not identify your Discord user ID.');
    }

    try {
      const response = await requestWebsiteApi(
        env,
        '/admin/darkroom/stats-sync',
        {
          body: { actorDiscordId: discordId },
          method: 'POST',
        },
      );
      const result = readDarkroomStatsSyncResponse(response);

      if (!result) {
        return ephemeralResponse(
          'The API synced darkroom stats but did not return details.',
        );
      }

      return ephemeralResponse(createDarkroomStatsSyncedEmbed(result));
    } catch (error) {
      return ephemeralResponse(
        `Could not sync darkroom stats: ${getErrorMessage(error)}`,
      );
    }
  },
};

function getInteractionUserId(interaction: {
  member?: { user?: { id?: string } };
  user?: { id?: string };
}) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function readDarkroomStatsSyncResponse(
  value: unknown,
): DarkroomStatsSyncResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const response = value as DarkroomStatsSyncApiResponse;
  const rollCount = readCount(response.rollCount);
  const userCount = readCount(response.userCount);
  if (rollCount === null || userCount === null) {
    return undefined;
  }

  return {
    discordMemberCount: readCount(response.discordMemberCount),
    ok: response.ok === true,
    rollCount,
    userCount,
    voiceChannelName:
      typeof response.voiceChannelName === 'string'
        ? response.voiceChannelName
        : null,
  };
}

function createDarkroomStatsSyncedEmbed(
  result: DarkroomStatsSyncResult,
): DiscordMessagePayload {
  return {
    embeds: [
      {
        color: result.ok ? 0x9f7aea : 0xf2c94c,
        fields: [
          {
            inline: true,
            name: 'Rolls',
            value: formatNumber(result.rollCount),
          },
          {
            inline: true,
            name: 'Unique Developers',
            value: formatNumber(result.userCount),
          },
          {
            inline: true,
            name: 'Discord Server Users',
            value:
              result.discordMemberCount === null
                ? 'Unknown'
                : formatNumber(result.discordMemberCount),
          },
          {
            inline: false,
            name: 'Voice Channel',
            value: result.voiceChannelName ?? 'Not updated',
          },
        ],
        footer: {
          text: 'Purdue Photography Club darkroom',
        },
        title: result.ok
          ? 'Darkroom Stats Synced'
          : 'Darkroom Stats Sync Needs Attention',
      },
    ],
  };
}

function readCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}

function formatNumber(value: number) {
  return NUMBER_FORMATTER.format(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
