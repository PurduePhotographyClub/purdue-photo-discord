import { discordApiRequest } from '../discord/api';
import type { Env } from '../discord/types';
import { getRequiredEnv } from '../utils/env';

interface DiscordGuildResponse {
  approximate_member_count?: number;
  approximate_presence_count?: number;
}

export async function getDiscordGuildStats(env: Env) {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const guild = await discordApiRequest<DiscordGuildResponse>(
    env,
    `/guilds/${guildId}?with_counts=true`,
  );

  return {
    memberCount: readCount(guild.approximate_member_count),
    presenceCount: readCount(guild.approximate_presence_count),
  };
}

function readCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}
