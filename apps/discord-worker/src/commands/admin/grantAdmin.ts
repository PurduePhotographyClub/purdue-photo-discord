/**
 * Discord-admin command for granting website admin access by account email.
 */
import type {
  DiscordApplicationCommandOption,
  DiscordCommand,
  DiscordMessagePayload,
} from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import { requestWebsiteApi } from '../../services/websiteApiService';
import { getErrorMessage } from '../../utils/errors';
import { getDiscordAdminRoleError } from './permissions';

const STRING_OPTION = 3;

interface GrantAdminApiResponse {
  email?: unknown;
  id?: unknown;
  name?: unknown;
  previousRole?: unknown;
  role?: unknown;
  updated?: unknown;
}

interface GrantedAdminAccount {
  email: string;
  id: string;
  name: string | null;
  previousRole: string;
  role: 'admin';
  updated: boolean;
}

export const grantAdminCommand: DiscordCommand = {
  definition: {
    description: 'Grant website admin access to an account email.',
    name: 'grant-admin',
    options: [
      {
        description: 'Website account email to make an admin.',
        name: 'email',
        required: true,
        type: STRING_OPTION,
      },
    ],
  },
  execute: async (interaction, env) => {
    const permissionError = getDiscordAdminRoleError(interaction, env);

    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    const email =
      getStringOption(interaction.data.options ?? [], 'email')
        ?.trim()
        .toLowerCase() ?? '';
    const discordId = getInteractionUserId(interaction);

    if (!isValidEmail(email)) {
      return ephemeralResponse('Use a valid email address.');
    }

    if (!discordId) {
      return ephemeralResponse('Could not identify your Discord user ID.');
    }

    try {
      const response = await requestWebsiteApi(env, '/admin/grant-admin', {
        body: {
          actorDiscordId: discordId,
          email,
        },
        method: 'POST',
      });
      const account = readGrantAdminResponse(response);

      if (!account) {
        return ephemeralResponse(
          'The API updated the account but did not return it.',
        );
      }

      return ephemeralResponse(createGrantAdminEmbed(account));
    } catch (error) {
      return ephemeralResponse(
        `Could not grant website admin: ${getErrorMessage(error)}`,
      );
    }
  },
};

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

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function readGrantAdminResponse(
  value: unknown,
): GrantedAdminAccount | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const response = value as GrantAdminApiResponse;
  if (
    typeof response.email !== 'string' ||
    typeof response.id !== 'string' ||
    response.role !== 'admin'
  ) {
    return undefined;
  }

  return {
    email: response.email,
    id: response.id,
    name: typeof response.name === 'string' ? response.name : null,
    previousRole:
      typeof response.previousRole === 'string'
        ? response.previousRole
        : 'user',
    role: 'admin',
    updated: response.updated === true,
  };
}

function createGrantAdminEmbed(
  account: GrantedAdminAccount,
): DiscordMessagePayload {
  return {
    embeds: [
      {
        color: account.updated ? 0x3fb950 : 0xf2c94c,
        fields: [
          {
            inline: false,
            name: 'Email',
            value: account.email,
          },
          {
            inline: true,
            name: 'Role',
            value: `${account.previousRole} -> ${account.role}`,
          },
          {
            inline: true,
            name: 'User ID',
            value: account.id,
          },
          {
            inline: true,
            name: 'Name',
            value: account.name || 'Unknown',
          },
        ],
        footer: {
          text: 'Purdue Photography Club',
        },
        title: account.updated
          ? 'Website Admin Granted'
          : 'Website Admin Already Present',
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
