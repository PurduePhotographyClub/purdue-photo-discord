/**
 * Shared admin-command permission check.
 *
 * Discord sends role IDs on interactions, not role names. Keep club role IDs in
 * one config file and compare directly against the member role list.
 */
import type { ApplicationCommandInteraction, Env } from '../../discord/types';
import { DISCORD_ROLE_IDS } from '../../config/discord-role-ids';

export function getExecutiveRoleError(
  interaction: ApplicationCommandInteraction,
  _env: Env,
): string | undefined {
  if (!interaction.member?.roles?.includes(DISCORD_ROLE_IDS.executive)) {
    return 'Only the Executive role can use this command.';
  }

  return undefined;
}

export function getDiscordAdminRoleError(
  interaction: ApplicationCommandInteraction,
  _env: Env,
): string | undefined {
  if (!interaction.member?.roles?.includes(DISCORD_ROLE_IDS.admin)) {
    return 'Only the Discord Admin role can use this command.';
  }

  return undefined;
}
