/**
 * Dispatches verified Discord interactions to commands and component handlers.
 *
 * Routes verify Discord signatures first. This layer only narrows payload shape
 * and sends each interaction type to the right feature module.
 */
import { InteractionType, MessageComponentTypes } from 'discord-interactions';
import { getCommand } from '../../config/commands';
import { handleButtonInteraction } from '../components/buttons';
import { handleModalSubmitInteraction } from '../components/modals';
import { handleSelectInteraction } from '../components/selects';
import { BadRequestError } from '../utils/errors';
import {
  ephemeralResponse,
  genericInteractionError,
  pongResponse,
} from './responses';
import type {
  ApplicationCommandInteraction,
  ComponentInteraction,
  DiscordInteraction,
  DiscordInteractionResponse,
  Env,
  ModalSubmitInteraction,
} from './types';

const SELECT_COMPONENT_TYPES = new Set<number>([
  MessageComponentTypes.STRING_SELECT,
  MessageComponentTypes.USER_SELECT,
  MessageComponentTypes.ROLE_SELECT,
  MessageComponentTypes.MENTIONABLE_SELECT,
  MessageComponentTypes.CHANNEL_SELECT,
]);

export async function handleDiscordInteraction(
  interaction: DiscordInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  // Discord sends all interaction callbacks to one URL. Keep this switch as the
  // narrow dispatcher and push feature behavior into commands/components.
  switch (interaction.type) {
    case InteractionType.PING:
      return pongResponse();

    case InteractionType.APPLICATION_COMMAND:
      return handleApplicationCommand(interaction, env);

    case InteractionType.MESSAGE_COMPONENT:
      return handleMessageComponent(interaction, env);

    case InteractionType.MODAL_SUBMIT:
      return handleModalSubmit(interaction, env);

    default:
      return genericInteractionError();
  }
}

async function handleApplicationCommand(
  interaction: DiscordInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  // Runtime guards keep malformed Discord/test payloads from reaching command
  // handlers that expect the narrowed TypeScript shape.
  if (!isApplicationCommandInteraction(interaction)) {
    throw new BadRequestError('Application command payload is missing a name.');
  }

  const command = getCommand(interaction.data.name);

  if (!command) {
    return ephemeralResponse(`Unknown command: ${interaction.data.name}`);
  }

  return command.execute(interaction, env);
}

async function handleMessageComponent(
  interaction: DiscordInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  if (!isComponentInteraction(interaction)) {
    throw new BadRequestError('Component payload is missing a custom_id.');
  }

  if (interaction.data.component_type === MessageComponentTypes.BUTTON) {
    return handleButtonInteraction(interaction, env);
  }

  if (SELECT_COMPONENT_TYPES.has(Number(interaction.data.component_type))) {
    return handleSelectInteraction(interaction, env);
  }

  return ephemeralResponse(
    `Unsupported component: ${interaction.data.custom_id}`,
  );
}

async function handleModalSubmit(
  interaction: DiscordInteraction,
  env: Env,
): Promise<DiscordInteractionResponse> {
  if (!isModalSubmitInteraction(interaction)) {
    throw new BadRequestError('Modal payload is missing a custom_id.');
  }

  return handleModalSubmitInteraction(interaction, env);
}

function isApplicationCommandInteraction(
  interaction: DiscordInteraction,
): interaction is ApplicationCommandInteraction {
  // Command handlers expect data.name, so guard before dispatching.
  return (
    isRecord(interaction.data) && typeof interaction.data.name === 'string'
  );
}

function isComponentInteraction(
  interaction: DiscordInteraction,
): interaction is ComponentInteraction {
  // Components are keyed by custom_id across buttons and select menus.
  return (
    isRecord(interaction.data) && typeof interaction.data.custom_id === 'string'
  );
}

function isModalSubmitInteraction(
  interaction: DiscordInteraction,
): interaction is ModalSubmitInteraction {
  // Modal submits also use custom_id to route form handling.
  return (
    isRecord(interaction.data) && typeof interaction.data.custom_id === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // Basic object guard used before reading fields from unknown Discord JSON.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
