/**
 * Executive command for changing the bot's visible Discord presence.
 *
 * The Worker checks the caller's Discord role, normalizes slash-command options,
 * then asks the VPS Gateway to apply the change because only the Gateway owns
 * the live discord.js client.
 */
import type {
  DiscordApplicationCommandOption,
  DiscordCommand,
} from '../../discord/types';
import { ephemeralResponse } from '../../discord/responses';
import {
  isGatewayPresenceStatus,
  updateGatewayPresence,
  type GatewayPresenceUpdate,
} from '../../services/gatewayApiService';
import { getErrorMessage } from '../../utils/errors';
import { getExecutiveRoleError } from './permissions';

const STRING_OPTION = 3;
const INTEGER_OPTION = 4;

export const statusCommand: DiscordCommand = {
  definition: {
    description: "Change the bot's Discord Gateway presence.",
    name: 'status',
    options: [
      {
        choices: [
          { name: 'Online', value: 'online' },
          { name: 'Idle', value: 'idle' },
          { name: 'Do Not Disturb', value: 'dnd' },
          { name: 'Invisible', value: 'invisible' },
        ],
        description: 'Online state to show in Discord.',
        name: 'status',
        required: false,
        type: STRING_OPTION,
      },
      {
        description: 'Activity text. Use "none" to clear it.',
        name: 'activity',
        required: false,
        type: STRING_OPTION,
      },
      {
        choices: [
          { name: 'Playing', value: 0 },
          { name: 'Listening to', value: 2 },
          { name: 'Watching', value: 3 },
          { name: 'Competing in', value: 5 },
        ],
        description: 'Activity verb to show before the activity text.',
        name: 'activity_type',
        required: false,
        type: INTEGER_OPTION,
      },
    ],
  },
  execute: async (interaction, env) => {
    // Keep role checks in the Worker; the Gateway API only knows signed machine
    // requests, not Discord members.
    const permissionError = getExecutiveRoleError(interaction, env);

    if (permissionError) {
      return ephemeralResponse(permissionError);
    }

    const update = parsePresenceUpdate(interaction.data.options ?? []);

    if (!update) {
      return ephemeralResponse(
        'Choose a status, activity, or activity type to update.',
      );
    }

    try {
      await updateGatewayPresence(env, update);
      return ephemeralResponse('Status changed!');
    } catch (error) {
      return ephemeralResponse(
        `Could not update Gateway presence: ${getErrorMessage(error)}`,
      );
    }
  },
};

function parsePresenceUpdate(
  options: DiscordApplicationCommandOption[],
): GatewayPresenceUpdate | undefined {
  // Discord sends slash-command options as a flat list here; normalize them into
  // the partial presence update accepted by the Gateway API.
  const update: GatewayPresenceUpdate = {};
  const status = getStringOption(options, 'status');
  const activity = getStringOption(options, 'activity');
  const activityType = getIntegerOption(options, 'activity_type');

  if (status !== undefined && isGatewayPresenceStatus(status)) {
    update.status = status;
  }

  if (activity !== undefined) {
    const trimmed = activity.trim();
    // "none" and "clear" are friendly command inputs for removing activity.
    update.activityName =
      trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'clear'
        ? null
        : trimmed;
  }

  if (activityType !== undefined) {
    update.activityType = activityType;
  }

  return Object.keys(update).length > 0 ? update : undefined;
}

function getStringOption(
  options: DiscordApplicationCommandOption[],
  name: string,
): string | undefined {
  // Discord option values are unknown at the type boundary, so narrow before
  // using the value as command input.
  const value = options.find((option) => option.name === name)?.value;
  return typeof value === 'string' ? value : undefined;
}

function getIntegerOption(
  options: DiscordApplicationCommandOption[],
  name: string,
): number | undefined {
  // Activity type choices are integers in Discord's command schema.
  const value = options.find((option) => option.name === name)?.value;
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}
