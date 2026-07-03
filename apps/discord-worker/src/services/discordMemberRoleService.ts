import { DISCORD_ROLE_IDS } from '../config/discord-role-ids';
import { discordApiRequest } from '../discord/api';
import type { Env, Snowflake } from '../discord/types';
import { BadRequestError, DiscordApiError } from '../utils/errors';
import { getRequiredEnv } from '../utils/env';
import { createLogger } from '../utils/logger';

type MembershipTier = 'facilities' | 'member';

export interface SyncDiscordMemberRolesInput {
  discordId: string;
  membershipExpired?: boolean;
  tier?: MembershipTier | null;
}

export interface SyncDiscordMemberRolesResult {
  addedRoleIds: string[];
  failedRoleIds: string[];
  inGuild: boolean;
  nicknameUpdateReason?: DiscordNicknameUpdateFailureReason;
  nicknameUpdated?: boolean;
  removedRoleIds: string[];
}

export interface WebsiteStaffRoleResolveResult {
  inGuild: boolean;
  matchedRoleIds: string[];
  websiteRole: 'admin' | 'officer' | null;
}

interface CompleteDiscordServerVerificationOptions {
  nickname?: string | null | undefined;
}

interface DiscordGuildMemberResponse {
  roles?: Snowflake[];
  user?: {
    id?: Snowflake;
  };
}

interface DiscordGuildRoleResponse {
  id?: Snowflake;
  permissions?: string;
  position?: number;
}

type DiscordNicknameUpdateFailureReason =
  | 'discord_api_error'
  | 'missing_access'
  | 'missing_manage_nicknames'
  | 'missing_member'
  | 'missing_permissions'
  | 'role_hierarchy'
  | 'unknown_error';

interface DiscordNicknameUpdateResult {
  reason?: DiscordNicknameUpdateFailureReason;
  updated: boolean;
}

const DISCORD_MISSING_ACCESS_CODE = 50001;
const DISCORD_MISSING_PERMISSIONS_CODE = 50013;
const DISCORD_UNKNOWN_MEMBER_CODE = 10007;
const DISCORD_UNKNOWN_ROLE_CODE = 10011;
const DISCORD_PERMISSION_ADMINISTRATOR = 1n << 3n;
const DISCORD_PERMISSION_MANAGE_NICKNAMES = 1n << 27n;
const logger = createLogger('discord-member-role-service');
const MANAGED_ROLE_IDS = uniqueRoleIds([
  // Only these website-owned roles are added or removed, so unrelated Discord roles are untouched.
  DISCORD_ROLE_IDS.websiteVerified,
  DISCORD_ROLE_IDS.membershipExpired,
  ...DISCORD_ROLE_IDS.membershipTiers.member,
  ...DISCORD_ROLE_IDS.membershipTiers.facilities,
]);
type DiscordMemberRoleUpdateMethod = 'DELETE' | 'PUT';
type DiscordMemberRoleUpdateResult =
  | 'applied'
  | 'member_missing'
  | 'role_missing';

interface DiscordMemberRoleUpdateOutcome {
  roleId: string;
  result: DiscordMemberRoleUpdateResult;
}

export async function addDiscordUnverifiedRole(
  env: Env,
  discordId: string,
): Promise<SyncDiscordMemberRolesResult> {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const trimmedDiscordId = discordId.trim();
  if (!trimmedDiscordId) {
    throw new BadRequestError('Discord user ID is required.');
  }

  const unverifiedRoleId = getServerUnverifiedRoleId(env);
  if (!unverifiedRoleId) {
    throw new BadRequestError('Discord unverified role ID is not configured.');
  }

  const member = await getGuildMember(env, guildId, trimmedDiscordId);
  if (!member) {
    return {
      addedRoleIds: [],
      failedRoleIds: [],
      inGuild: false,
      removedRoleIds: [],
    };
  }

  const existingRoleIds = new Set(member.roles ?? []);
  if (
    existingRoleIds.has(getServerVerifiedRoleId(env)) ||
    existingRoleIds.has(unverifiedRoleId)
  ) {
    return {
      addedRoleIds: [],
      failedRoleIds: [],
      inGuild: true,
      removedRoleIds: [],
    };
  }

  await discordApiRequest(
    env,
    `/guilds/${guildId}/members/${trimmedDiscordId}/roles/${unverifiedRoleId}`,
    { method: 'PUT' },
  );

  return {
    addedRoleIds: [unverifiedRoleId],
    failedRoleIds: [],
    inGuild: true,
    removedRoleIds: [],
  };
}

export async function completeDiscordServerVerification(
  env: Env,
  discordId: string,
  options: CompleteDiscordServerVerificationOptions = {},
): Promise<SyncDiscordMemberRolesResult> {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const trimmedDiscordId = discordId.trim();
  if (!trimmedDiscordId) {
    throw new BadRequestError('Discord user ID is required.');
  }

  const verifiedRoleId = getServerVerifiedRoleId(env);
  if (!verifiedRoleId) {
    throw new BadRequestError('Discord verified role ID is not configured.');
  }

  const member = await getGuildMember(env, guildId, trimmedDiscordId);
  if (!member) {
    return {
      addedRoleIds: [],
      failedRoleIds: [],
      inGuild: false,
      removedRoleIds: [],
    };
  }

  const unverifiedRoleId = getServerUnverifiedRoleId(env);
  const existingRoleIds = new Set(member.roles ?? []);
  const addedRoleIds: string[] = [];
  const removedRoleIds: string[] = [];
  const nickname = normalizeDiscordVerificationNickname(options.nickname);
  let nicknameUpdate: DiscordNicknameUpdateResult = { updated: false };

  if (!existingRoleIds.has(verifiedRoleId)) {
    await discordApiRequest(
      env,
      `/guilds/${guildId}/members/${trimmedDiscordId}/roles/${verifiedRoleId}`,
      { method: 'PUT' },
    );
    addedRoleIds.push(verifiedRoleId);
  }

  if (
    unverifiedRoleId &&
    unverifiedRoleId !== verifiedRoleId &&
    existingRoleIds.has(unverifiedRoleId)
  ) {
    await discordApiRequest(
      env,
      `/guilds/${guildId}/members/${trimmedDiscordId}/roles/${unverifiedRoleId}`,
      { method: 'DELETE' },
    );
    removedRoleIds.push(unverifiedRoleId);
  }

  if (nickname) {
    nicknameUpdate = await updateDiscordMemberNickname(
      env,
      guildId,
      trimmedDiscordId,
      nickname,
      member,
    );
  }

  return {
    addedRoleIds,
    failedRoleIds: [],
    inGuild: true,
    ...(nickname ? { nicknameUpdated: nicknameUpdate.updated } : {}),
    ...(nicknameUpdate.reason
      ? { nicknameUpdateReason: nicknameUpdate.reason }
      : {}),
    removedRoleIds,
  };
}

function normalizeDiscordVerificationNickname(
  nickname: string | null | undefined,
) {
  const normalized =
    nickname?.normalize('NFKC').replace(/\s+/g, ' ').trim() ?? '';
  return normalized ? normalized.slice(0, 32) : null;
}

export async function syncDiscordMemberRoles(
  env: Env,
  input: SyncDiscordMemberRolesInput,
): Promise<SyncDiscordMemberRolesResult> {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const discordId = input.discordId.trim();
  if (!discordId) {
    throw new BadRequestError('Discord user ID is required.');
  }

  const member = await getGuildMember(env, guildId, discordId);
  if (!member) {
    return {
      addedRoleIds: [],
      failedRoleIds: [],
      inGuild: false,
      removedRoleIds: [],
    };
  }

  const existingRoleIds = new Set(member.roles ?? []);
  const roleIdsToAdd = getDesiredRoleIds(input);
  // Anything managed by the website but no longer desired is cleaned up during every sync.
  const roleIdsToRemove = MANAGED_ROLE_IDS.filter(
    (roleId) => !roleIdsToAdd.includes(roleId),
  );

  const addOutcomes = await updateDiscordMemberRoles(
    env,
    guildId,
    discordId,
    roleIdsToAdd.filter((roleId) => !existingRoleIds.has(roleId)),
    'PUT',
  );
  const addedRoleIds = getRoleIdsForResult(addOutcomes, 'applied');
  const addFailedRoleIds = getRoleIdsForResult(addOutcomes, 'role_missing');

  if (hasRoleUpdateResult(addOutcomes, 'member_missing')) {
    return {
      addedRoleIds,
      failedRoleIds: addFailedRoleIds,
      inGuild: false,
      removedRoleIds: [],
    };
  }

  const removeOutcomes = await updateDiscordMemberRoles(
    env,
    guildId,
    discordId,
    roleIdsToRemove.filter((roleId) => existingRoleIds.has(roleId)),
    'DELETE',
  );
  const removedRoleIds = getRoleIdsForResult(removeOutcomes, 'applied');
  const failedRoleIds = [
    ...addFailedRoleIds,
    ...getRoleIdsForResult(removeOutcomes, 'role_missing'),
  ];

  if (hasRoleUpdateResult(removeOutcomes, 'member_missing')) {
    return {
      addedRoleIds,
      failedRoleIds,
      inGuild: false,
      removedRoleIds,
    };
  }

  return {
    addedRoleIds,
    failedRoleIds,
    inGuild: true,
    removedRoleIds,
  };
}

export async function removeDiscordManagedRoles(
  env: Env,
  discordId: string,
): Promise<SyncDiscordMemberRolesResult> {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const trimmedDiscordId = discordId.trim();
  if (!trimmedDiscordId) {
    throw new BadRequestError('Discord user ID is required.');
  }

  const member = await getGuildMember(env, guildId, trimmedDiscordId);
  if (!member) {
    return {
      addedRoleIds: [],
      failedRoleIds: [],
      inGuild: false,
      removedRoleIds: [],
    };
  }

  const existingRoleIds = new Set(member.roles ?? []);
  const removeOutcomes = await updateDiscordMemberRoles(
    env,
    guildId,
    trimmedDiscordId,
    MANAGED_ROLE_IDS.filter((roleId) => existingRoleIds.has(roleId)),
    'DELETE',
  );
  const removedRoleIds = getRoleIdsForResult(removeOutcomes, 'applied');
  const failedRoleIds = getRoleIdsForResult(removeOutcomes, 'role_missing');

  if (hasRoleUpdateResult(removeOutcomes, 'member_missing')) {
    return {
      addedRoleIds: [],
      failedRoleIds,
      inGuild: false,
      removedRoleIds,
    };
  }

  return {
    addedRoleIds: [],
    failedRoleIds,
    inGuild: true,
    removedRoleIds,
  };
}

export async function resolveWebsiteStaffRoleForDiscordMember(
  env: Env,
  discordId: string,
): Promise<WebsiteStaffRoleResolveResult> {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const trimmedDiscordId = discordId.trim();
  if (!trimmedDiscordId) {
    throw new BadRequestError('Discord user ID is required.');
  }

  const member = await getGuildMember(env, guildId, trimmedDiscordId);
  if (!member) {
    return {
      inGuild: false,
      matchedRoleIds: [],
      websiteRole: null,
    };
  }

  const existingRoleIds = new Set(member.roles ?? []);
  const matchedRoleIds = [
    DISCORD_ROLE_IDS.admin,
    DISCORD_ROLE_IDS.executive,
  ].filter((roleId) => existingRoleIds.has(roleId));

  return {
    inGuild: true,
    matchedRoleIds,
    websiteRole: resolveWebsiteRoleFromDiscordRoleIds(existingRoleIds),
  };
}

async function getGuildMember(env: Env, guildId: string, discordId: string) {
  try {
    return await discordApiRequest<DiscordGuildMemberResponse>(
      env,
      `/guilds/${guildId}/members/${discordId}`,
    );
  } catch (error) {
    // Discord returns 404 when the linked account is not in the configured server.
    if (error instanceof DiscordApiError && error.status === 404) {
      return null;
    }

    throw error;
  }
}

function resolveWebsiteRoleFromDiscordRoleIds(roleIds: Set<string>) {
  if (roleIds.has(DISCORD_ROLE_IDS.admin)) {
    return 'admin';
  }

  if (roleIds.has(DISCORD_ROLE_IDS.executive)) {
    return 'officer';
  }

  return null;
}

async function updateDiscordMemberRole(
  env: Env,
  guildId: string,
  discordId: string,
  roleId: string,
  method: DiscordMemberRoleUpdateMethod,
): Promise<DiscordMemberRoleUpdateResult> {
  try {
    await discordApiRequest(
      env,
      `/guilds/${guildId}/members/${discordId}/roles/${roleId}`,
      { method },
    );

    return 'applied';
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      const discordErrorCode = readDiscordErrorCode(error.details);
      if (discordErrorCode === DISCORD_UNKNOWN_MEMBER_CODE) {
        return 'member_missing';
      }
      if (discordErrorCode === DISCORD_UNKNOWN_ROLE_CODE) {
        return 'role_missing';
      }
    }

    throw error;
  }
}

async function updateDiscordMemberNickname(
  env: Env,
  guildId: string,
  discordId: string,
  nickname: string,
  targetMember: DiscordGuildMemberResponse,
): Promise<DiscordNicknameUpdateResult> {
  try {
    await discordApiRequest(env, `/guilds/${guildId}/members/${discordId}`, {
      body: JSON.stringify({ nick: nickname }),
      method: 'PATCH',
    });

    return { updated: true };
  } catch (error) {
    const result = await resolveDiscordNicknameUpdateFailure(
      env,
      guildId,
      targetMember,
      error,
    );

    logger.warn('Discord verification nickname update failed.', {
      discordErrorCode:
        error instanceof DiscordApiError
          ? readDiscordErrorCode(error.details)
          : undefined,
      discordId,
      error,
      reason: result.reason,
      status: error instanceof DiscordApiError ? error.status : undefined,
    });

    return result;
  }
}

async function resolveDiscordNicknameUpdateFailure(
  env: Env,
  guildId: string,
  targetMember: DiscordGuildMemberResponse,
  error: unknown,
): Promise<DiscordNicknameUpdateResult> {
  if (!(error instanceof DiscordApiError)) {
    return { reason: 'unknown_error', updated: false };
  }

  const discordErrorCode = readDiscordErrorCode(error.details);
  if (discordErrorCode === DISCORD_UNKNOWN_MEMBER_CODE) {
    return { reason: 'missing_member', updated: false };
  }
  if (discordErrorCode === DISCORD_MISSING_ACCESS_CODE) {
    return { reason: 'missing_access', updated: false };
  }
  if (discordErrorCode === DISCORD_MISSING_PERMISSIONS_CODE) {
    const reason = await resolveNicknamePermissionFailureReason(
      env,
      guildId,
      targetMember,
    ).catch((): DiscordNicknameUpdateFailureReason => 'missing_permissions');

    return { reason, updated: false };
  }

  return { reason: 'discord_api_error', updated: false };
}

async function resolveNicknamePermissionFailureReason(
  env: Env,
  guildId: string,
  targetMember: DiscordGuildMemberResponse,
): Promise<DiscordNicknameUpdateFailureReason> {
  const botDiscordId = env.DISCORD_APPLICATION_ID?.trim();
  if (!botDiscordId) {
    return 'missing_permissions';
  }

  const [botMember, roles] = await Promise.all([
    getGuildMember(env, guildId, botDiscordId),
    getGuildRoles(env, guildId),
  ]);
  if (!botMember) {
    return 'missing_permissions';
  }

  const botPermissions = getGuildMemberPermissions(guildId, botMember, roles);
  if (!hasPermission(botPermissions, DISCORD_PERMISSION_MANAGE_NICKNAMES)) {
    return 'missing_manage_nicknames';
  }

  const botTopRolePosition = getHighestRolePosition(
    botMember.roles ?? [],
    roles,
  );
  const targetTopRolePosition = getHighestRolePosition(
    targetMember.roles ?? [],
    roles,
  );

  return targetTopRolePosition >= botTopRolePosition
    ? 'role_hierarchy'
    : 'missing_permissions';
}

async function getGuildRoles(env: Env, guildId: string) {
  return discordApiRequest<DiscordGuildRoleResponse[]>(
    env,
    `/guilds/${guildId}/roles`,
  );
}

function getGuildMemberPermissions(
  guildId: string,
  member: DiscordGuildMemberResponse,
  roles: readonly DiscordGuildRoleResponse[],
) {
  const memberRoleIds = new Set([guildId, ...(member.roles ?? [])]);
  return roles.reduce((permissions, role) => {
    if (!role.id || !memberRoleIds.has(role.id)) {
      return permissions;
    }

    return permissions | parseDiscordPermissionBits(role.permissions);
  }, 0n);
}

function getHighestRolePosition(
  roleIds: readonly string[],
  roles: readonly DiscordGuildRoleResponse[],
) {
  const roleIdSet = new Set(roleIds);
  return roles.reduce((highestPosition, role) => {
    if (!role.id || !roleIdSet.has(role.id)) {
      return highestPosition;
    }

    return Math.max(highestPosition, role.position ?? 0);
  }, 0);
}

function parseDiscordPermissionBits(value: string | undefined) {
  if (!value) {
    return 0n;
  }

  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function hasPermission(permissions: bigint, permission: bigint) {
  return (
    (permissions & DISCORD_PERMISSION_ADMINISTRATOR) ===
      DISCORD_PERMISSION_ADMINISTRATOR ||
    (permissions & permission) === permission
  );
}

async function updateDiscordMemberRoles(
  env: Env,
  guildId: string,
  discordId: string,
  roleIds: readonly string[],
  method: DiscordMemberRoleUpdateMethod,
): Promise<DiscordMemberRoleUpdateOutcome[]> {
  return Promise.all(
    roleIds.map(async (roleId) => ({
      roleId,
      result: await updateDiscordMemberRole(
        env,
        guildId,
        discordId,
        roleId,
        method,
      ),
    })),
  );
}

function getRoleIdsForResult(
  outcomes: readonly DiscordMemberRoleUpdateOutcome[],
  result: DiscordMemberRoleUpdateResult,
) {
  return outcomes.flatMap((outcome) =>
    outcome.result === result ? [outcome.roleId] : [],
  );
}

function hasRoleUpdateResult(
  outcomes: readonly DiscordMemberRoleUpdateOutcome[],
  result: DiscordMemberRoleUpdateResult,
) {
  return outcomes.some((outcome) => outcome.result === result);
}

function getDesiredRoleIds(input: SyncDiscordMemberRolesInput) {
  const roleIds: string[] = [DISCORD_ROLE_IDS.websiteVerified];

  if (input.membershipExpired) {
    // Expired members keep the website marker role but swap tier roles for the expired marker.
    roleIds.push(DISCORD_ROLE_IDS.membershipExpired);
  } else if (input.tier) {
    roleIds.push(...DISCORD_ROLE_IDS.membershipTiers[input.tier]);
  }

  return uniqueRoleIds(roleIds);
}

export function getServerVerifiedRoleId(env: Env) {
  return (
    env.DISCORD_VERIFIED_ROLE_ID?.trim() || DISCORD_ROLE_IDS.serverVerified
  );
}

export function getServerUnverifiedRoleId(env: Env) {
  return (
    env.DISCORD_UNVERIFIED_ROLE_ID?.trim() || DISCORD_ROLE_IDS.serverUnverified
  );
}

function uniqueRoleIds(roleIds: readonly string[]) {
  return [...new Set(roleIds.filter(Boolean))];
}

function readDiscordErrorCode(details: unknown) {
  if (
    typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details) &&
    typeof (details as { code?: unknown }).code === 'number'
  ) {
    return (details as { code: number }).code;
  }

  return null;
}
