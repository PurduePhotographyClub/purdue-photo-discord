/**
 * Creates Discord scheduled events from website event records.
 */
import { discordApiRequest } from '../discord/api';
import type { Env } from '../discord/types';
import { getRequiredEnv } from '../utils/env';
import { BadRequestError, DiscordApiError } from '../utils/errors';

const DISCORD_GUILD_ONLY_PRIVACY_LEVEL = 2;
const DISCORD_EXTERNAL_EVENT_TYPE = 3;
const DEFAULT_LOCATION = 'Purdue University';

export interface CreateDiscordScheduledEventInput {
  description?: string | null;
  endsAt?: string | null;
  location?: string | null;
  startsAt: string;
  title: string;
}

export interface UpdateDiscordScheduledEventInput extends CreateDiscordScheduledEventInput {
  discordEventId: string;
}

export interface DeleteDiscordScheduledEventInput {
  discordEventId: string;
}

interface DiscordScheduledEventResponse {
  id?: string;
}

export async function createDiscordScheduledEvent(
  env: Env,
  input: CreateDiscordScheduledEventInput,
) {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const body = buildScheduledEventBody(input);

  return discordApiRequest<DiscordScheduledEventResponse>(
    env,
    `/guilds/${guildId}/scheduled-events`,
    {
      body: JSON.stringify(body),
      method: 'POST',
    },
  );
}

export async function updateDiscordScheduledEvent(
  env: Env,
  input: UpdateDiscordScheduledEventInput,
) {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const discordEventId = readDiscordEventId(input.discordEventId);
  const body = buildScheduledEventBody(input);

  return discordApiRequest<DiscordScheduledEventResponse>(
    env,
    `/guilds/${guildId}/scheduled-events/${discordEventId}`,
    {
      body: JSON.stringify(body),
      method: 'PATCH',
    },
  );
}

export async function deleteDiscordScheduledEvent(
  env: Env,
  input: DeleteDiscordScheduledEventInput,
) {
  const guildId = getRequiredEnv(env, 'DISCORD_GUILD_ID');
  const discordEventId = readDiscordEventId(input.discordEventId);

  try {
    await discordApiRequest<unknown>(
      env,
      `/guilds/${guildId}/scheduled-events/${discordEventId}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      return;
    }

    throw error;
  }
}

function buildScheduledEventBody(input: CreateDiscordScheduledEventInput) {
  const startDate = parseDiscordDate(input.startsAt, 'startsAt');
  const endDate = input.endsAt
    ? parseDiscordDate(input.endsAt, 'endsAt')
    : new Date(startDate.getTime() + 2 * 60 * 60 * 1000);

  if (endDate <= startDate) {
    throw new BadRequestError(
      'Scheduled event end time must be after start time.',
    );
  }

  const location = truncate(input.location?.trim() || DEFAULT_LOCATION, 100);
  const body: Record<string, unknown> = {
    entity_metadata: { location },
    entity_type: DISCORD_EXTERNAL_EVENT_TYPE,
    name: truncate(input.title.trim(), 100),
    privacy_level: DISCORD_GUILD_ONLY_PRIVACY_LEVEL,
    scheduled_end_time: endDate.toISOString(),
    scheduled_start_time: startDate.toISOString(),
  };

  const description = input.description?.trim();
  if (description) {
    body.description = truncate(description, 1_000);
  }

  return body;
}

function readDiscordEventId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestError('Discord scheduled event ID is required.');
  }

  return trimmed;
}

function parseDiscordDate(value: string, fieldName: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`${fieldName} must be a valid ISO date.`);
  }

  return parsed;
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
