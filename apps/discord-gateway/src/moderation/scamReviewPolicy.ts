import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import type { GatewayScamModerationConfig } from '../config.js';
import type { ScamReviewAction } from './scamModerationAlert.js';
import type { ScamModerationAlert } from './scamModerationService.js';

const REVIEW_MODERATOR_ROLE_IDS = new Set([
  '1364457359061155870',
  '1198569577383198730',
]);
const PROTECTED_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ModerateMembers,
] as const;

export function isScamReviewModerator(member: GuildMember) {
  return [...member.roles.cache.keys()].some((roleId) =>
    REVIEW_MODERATOR_ROLE_IDS.has(roleId),
  );
}

export function isProtectedScamMember(
  member: GuildMember,
  config: GatewayScamModerationConfig,
) {
  return (
    [...member.roles.cache.keys()].some((roleId) =>
      config.protectedRoleIds.has(roleId),
    ) ||
    PROTECTED_PERMISSIONS.some((permission) =>
      member.permissions.has(permission),
    )
  );
}

export function isScamReviewActionAllowed(
  alert: ScamModerationAlert,
  action: ScamReviewAction,
) {
  if (alert.reviewReason === 'reported_scam' || alert.protectedMember) {
    return action === 'reviewed';
  }
  return action === 'confirm' || action === 'dismiss';
}
