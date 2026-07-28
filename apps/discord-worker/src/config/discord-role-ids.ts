export interface DiscordMembershipRoleConfiguration {
  facilitiesRoleId: string;
  managedRoleIds: readonly string[];
  memberRoleId: string;
}

export const DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION = {
  facilitiesRoleId: '1519105558127575141',
  managedRoleIds: ['1519105703736770600', '1519105558127575141'],
  memberRoleId: '1519105703736770600',
} as const satisfies DiscordMembershipRoleConfiguration;

export const DISCORD_ROLE_IDS = {
  admin: '1364457359061155870',
  executive: '1198569577383198730',
  honeypotRestricted: '1515784633374212247',
  jobsAccess: '1523461630522953928',
  legacyMembershipTierIds: ['1512510317740036216'],
  membershipExpired: '1512510317740036216',
  serverUnverified: '1503180707550199920',
  serverVerified: '1503180707550199920',
  membershipTiers: {
    facilities: [
      DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION.memberRoleId,
      DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION.facilitiesRoleId,
    ],
    member: [DEFAULT_DISCORD_MEMBERSHIP_ROLE_CONFIGURATION.memberRoleId],
  },
  websiteVerified: '1503180707550199920',
} as const;
