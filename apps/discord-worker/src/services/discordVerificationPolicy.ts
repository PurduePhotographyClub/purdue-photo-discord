const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACCOUNT_AGE_DAYS = 1;
const MIN_ACCOUNT_AGE_DAYS = 1;
const MAX_ACCOUNT_AGE_DAYS = 7;

export interface DiscordAccountAgeDecision {
  allowed: boolean;
  createdAt: Date | null;
  minimumAgeDays: number;
  retryAt: Date | null;
}

export function getConfiguredDiscordAccountAgeDays(value: string | undefined) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_ACCOUNT_AGE_DAYS;
  }

  return Math.min(MAX_ACCOUNT_AGE_DAYS, Math.max(MIN_ACCOUNT_AGE_DAYS, parsed));
}

export function getDiscordAccountAgeDecision(
  discordId: string,
  configuredMinimumDays: string | undefined,
  now = new Date(),
): DiscordAccountAgeDecision {
  const minimumAgeDays = getConfiguredDiscordAccountAgeDays(
    configuredMinimumDays,
  );
  const createdAt = getDiscordAccountCreatedAt(discordId);
  if (!createdAt) {
    return {
      allowed: false,
      createdAt: null,
      minimumAgeDays,
      retryAt: null,
    };
  }

  const retryAt = new Date(createdAt.getTime() + minimumAgeDays * DAY_MS);
  return {
    allowed: retryAt <= now,
    createdAt,
    minimumAgeDays,
    retryAt,
  };
}

export function getDiscordAccountCreatedAt(discordId: string) {
  if (!/^\d{17,20}$/.test(discordId)) {
    return null;
  }

  try {
    const snowflake = BigInt(discordId);
    const timestamp = Number((snowflake >> 22n) + DISCORD_EPOCH_MS);
    const createdAt = new Date(timestamp);

    return Number.isNaN(createdAt.getTime()) ? null : createdAt;
  } catch {
    return null;
  }
}
