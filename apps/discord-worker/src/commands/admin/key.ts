/**
 * Executive command for generating website activation keys.
 */
import type {
  DiscordApplicationCommandOption,
  DiscordCommand,
  DiscordMessagePayload,
} from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { requestWebsiteApi } from '../../services/websiteApiService';
import { getErrorMessage } from '../../utils/errors';
import { getExecutiveRoleError } from './permissions';

const STRING_OPTION = 3;

interface GenerateKeyResponse {
  id: string;
  key: string;
}

type MembershipTier = 'facilities' | 'member';

export const keyCommand: DiscordCommand = {
  definition: {
    description: 'Generate an activation key.',
    name: 'key',
    options: [
      {
        choices: [
          { name: 'Member', value: 'member' },
          { name: 'Facilities', value: 'facilities' },
        ],
        description: 'Membership tier this key activates.',
        name: 'tier',
        required: true,
        type: STRING_OPTION,
      },
      {
        description: 'Expiration date, like 2026-08-15.',
        name: 'expires_at',
        required: true,
        type: STRING_OPTION,
      },
    ],
  },
  execute: async (interaction, env) => {
    const permissionError = getExecutiveRoleError(interaction, env);

    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    const tier = getTierOption(interaction.data.options ?? []);
    const expiresAt = getStringOption(
      interaction.data.options ?? [],
      'expires_at',
    );
    const discordId = getInteractionUserId(interaction);

    if (!tier) {
      return ephemeralResponse('Choose a valid tier: member or facilities.');
    }

    if (
      !expiresAt ||
      Number.isNaN(Date.parse(normalizeExpiration(expiresAt)))
    ) {
      return ephemeralResponse('Use a valid expiration date, like 2026-08-15.');
    }

    if (!discordId) {
      return ephemeralResponse('Could not identify your Discord user ID.');
    }

    try {
      const response = await requestWebsiteApi(env, '/keys/generate', {
        body: {
          discordId,
          expiresAt,
          tier,
        },
        method: 'POST',
      });
      const key = readGeneratedKey(response);

      if (!key) {
        return ephemeralResponse(
          'The API generated a key but did not return it.',
        );
      }

      return ephemeralResponse(
        createGeneratedKeyEmbed({
          expiresAt,
          key: key.key,
          tier,
        }),
      );
    } catch (error) {
      return ephemeralResponse(
        `Could not generate key: ${getErrorMessage(error)}`,
      );
    }
  },
};

function getTierOption(
  options: DiscordApplicationCommandOption[],
): MembershipTier | undefined {
  const value = getStringOption(options, 'tier');
  return value === 'member' || value === 'facilities' ? value : undefined;
}

function getStringOption(
  options: DiscordApplicationCommandOption[],
  name: string,
): string | undefined {
  const value = options.find((option) => option.name === name)?.value;
  return typeof value === 'string' ? value : undefined;
}

function getInteractionUserId(interaction: {
  member?: { user?: { id?: string } };
  user?: { id?: string };
}) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function normalizeExpiration(value: string) {
  return value.includes('T') ? value : `${value}T23:59:59`;
}

function readGeneratedKey(value: unknown): GenerateKeyResponse | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('key' in value)
  ) {
    return undefined;
  }

  const id = value.id;
  const key = value.key;
  return typeof id === 'string' && typeof key === 'string'
    ? { id, key }
    : undefined;
}

function formatTier(tier: MembershipTier) {
  return tier === 'facilities' ? 'Facilities' : 'Member';
}

function createGeneratedKeyEmbed(input: {
  expiresAt: string;
  key: string;
  tier: MembershipTier;
}): DiscordMessagePayload {
  return {
    embeds: [
      {
        color: input.tier === 'facilities' ? 0x58a6ff : 0x57d68d,
        fields: [
          {
            inline: false,
            name: 'Activation Key',
            value: `\`${input.key}\``,
          },
          {
            inline: true,
            name: 'Tier',
            value: formatTier(input.tier),
          },
          {
            inline: true,
            name: 'Expires',
            value: input.expiresAt,
          },
        ],
        footer: {
          text: 'Purdue Photography Club',
        },
        title: 'Activation Key Generated',
      },
    ],
  };
}
