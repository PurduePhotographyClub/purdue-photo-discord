/**
 * Small Discord REST client used by Worker services and scripts.
 *
 * This keeps Bot auth, JSON defaults, and Discord error wrapping in one place so
 * feature code only needs to describe the endpoint it wants to call.
 */
import type { DiscordApplicationCommandDefinition, Env } from './types';
import { ConfigError, DiscordApiError } from '../utils/errors';
import { getOptionalEnv, getRequiredEnv } from '../utils/env';
import { createLogger } from '../utils/logger';

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const DISCORD_MAX_RATE_LIMIT_RETRIES = 1;
const DISCORD_MAX_RETRY_DELAY_MS = 2_500;
const logger = createLogger('discord-api');

export type CommandRegistrationScope = 'auto' | 'global' | 'guild';

export interface CommandRegistrationOptions {
  cleanupGlobal?: boolean;
  cleanupGuild?: boolean;
  guildId?: string | undefined;
  scope?: CommandRegistrationScope | undefined;
}

export interface CommandRegistrationResult {
  cleanup: Array<{
    result: unknown;
    scope: 'global' | 'guild';
  }>;
  registered: unknown;
  registeredScope: 'global' | 'guild';
}

export async function discordApiRequest<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  // Pull the token at call time so tests and scripts can pass different envs.
  const token = getRequiredEnv(env, 'DISCORD_TOKEN');
  const headers = new Headers(init.headers);

  // Centralize Bot auth and JSON defaults so service code only describes the
  // Discord endpoint and body it needs.
  headers.set('Authorization', `Bot ${token}`);

  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json;charset=UTF-8');
  }

  const normalizedPath = normalizePath(path);
  const method = init.method ?? 'GET';
  const startedAt = Date.now();
  let response: Response;

  for (
    let attempt = 0;
    attempt <= DISCORD_MAX_RATE_LIMIT_RETRIES;
    attempt += 1
  ) {
    try {
      response = await fetch(`${DISCORD_API_BASE_URL}${normalizedPath}`, {
        ...init,
        headers,
      });
    } catch (error) {
      logger.error('Discord API request failed before response.', {
        error,
        latencyMs: Date.now() - startedAt,
        method,
        path: normalizedPath,
      });
      throw error;
    }

    const responseText = await response.text();
    const responseBody = parseDiscordApiBody(responseText);

    if (response.status === 429 && attempt < DISCORD_MAX_RATE_LIMIT_RETRIES) {
      const retryAfterMs = readRetryAfterMs(response, responseBody);
      logger.warn('Discord API request rate-limited; retrying once.', {
        bucket: response.headers.get('x-ratelimit-bucket') ?? undefined,
        globalRateLimit:
          response.headers.get('x-ratelimit-global') ?? undefined,
        latencyMs: Date.now() - startedAt,
        method,
        path: normalizedPath,
        retryAfterMs,
        status: response.status,
      });
      await sleep(retryAfterMs);
      continue;
    }

    if (!response.ok) {
      logger.warn('Discord API request failed.', {
        bucket: response.headers.get('x-ratelimit-bucket') ?? undefined,
        globalRateLimit:
          response.headers.get('x-ratelimit-global') ?? undefined,
        latencyMs: Date.now() - startedAt,
        method,
        path: normalizedPath,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        status: response.status,
      });

      // Preserve Discord's response body for logs/tests while keeping HTTP status
      // handling consistent for Worker routes.
      throw new DiscordApiError(
        `Discord API request failed with ${response.status}.`,
        response.status,
        responseBody,
      );
    }

    return responseBody as T;
  }

  throw new DiscordApiError('Discord API request failed with 429.', 429);
}

export async function registerGlobalCommands(
  env: Env,
  commands: readonly DiscordApplicationCommandDefinition[],
): Promise<unknown> {
  // Discord replaces the global command set on PUT, so pass the whole registry.
  const applicationId = getRequiredEnv(env, 'DISCORD_APPLICATION_ID');

  return discordApiRequest(env, `/applications/${applicationId}/commands`, {
    body: JSON.stringify(commands),
    method: 'PUT',
  });
}

export async function registerGuildCommands(
  env: Env,
  guildId: string,
  commands: readonly DiscordApplicationCommandDefinition[],
): Promise<unknown> {
  // Guild commands update quickly and are the best choice while testing new
  // commands like /admin before moving them global.
  const applicationId = getRequiredEnv(env, 'DISCORD_APPLICATION_ID');

  return discordApiRequest(
    env,
    `/applications/${applicationId}/guilds/${guildId}/commands`,
    {
      body: JSON.stringify(commands),
      method: 'PUT',
    },
  );
}

export async function registerApplicationCommands(
  env: Env,
  commands: readonly DiscordApplicationCommandDefinition[],
  options: CommandRegistrationOptions = {},
): Promise<CommandRegistrationResult> {
  const target = resolveCommandRegistrationTarget(env, options);
  const registered =
    target.scope === 'guild'
      ? await registerGuildCommands(env, target.guildId, commands)
      : await registerGlobalCommands(env, commands);
  const cleanup = await cleanupCommandScopes(env, target.scope, options);

  return {
    cleanup,
    registered,
    registeredScope: target.scope,
  };
}

export async function clearGlobalCommands(env: Env) {
  return registerGlobalCommands(env, []);
}

export async function clearGuildCommands(env: Env, guildId: string) {
  return registerGuildCommands(env, guildId, []);
}

function resolveCommandRegistrationTarget(
  env: Env,
  options: CommandRegistrationOptions,
): { guildId: string; scope: 'guild' } | { scope: 'global' } {
  const scope = options.scope ?? 'auto';
  const guildId = readCommandGuildId(env, options);

  if (scope === 'global') {
    return { scope: 'global' };
  }

  if (scope === 'guild') {
    if (!guildId) {
      throw new ConfigError(
        'DISCORD_GUILD_ID is required when registering guild commands.',
      );
    }

    return { guildId, scope: 'guild' };
  }

  return guildId ? { guildId, scope: 'guild' } : { scope: 'global' };
}

async function cleanupCommandScopes(
  env: Env,
  registeredScope: 'global' | 'guild',
  options: CommandRegistrationOptions,
): Promise<CommandRegistrationResult['cleanup']> {
  const cleanup: CommandRegistrationResult['cleanup'] = [];

  if (options.cleanupGlobal === true && registeredScope !== 'global') {
    cleanup.push({
      result: await clearGlobalCommands(env),
      scope: 'global',
    });
  }

  if (options.cleanupGuild === true && registeredScope !== 'guild') {
    const guildId = readCommandGuildId(env, options);
    if (!guildId) {
      throw new ConfigError(
        'DISCORD_GUILD_ID is required when clearing guild commands.',
      );
    }

    cleanup.push({
      result: await clearGuildCommands(env, guildId),
      scope: 'guild',
    });
  }

  return cleanup;
}

function readCommandGuildId(
  env: Env,
  options: Pick<CommandRegistrationOptions, 'guildId'>,
) {
  return options.guildId?.trim() || getOptionalEnv(env, 'DISCORD_GUILD_ID');
}

function normalizePath(path: string): string {
  // Let callers use either "channels/..." or "/channels/...".
  return path.startsWith('/') ? path : `/${path}`;
}

function parseDiscordApiBody(body: string): unknown {
  // Some Discord endpoints legitimately return 204/empty bodies.
  if (body.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function readRetryAfterMs(response: Response, responseBody: unknown) {
  const bodyRetryAfter = isRecord(responseBody)
    ? readNumericRetryAfter(responseBody.retry_after)
    : null;
  const headerRetryAfter = readNumericRetryAfter(
    response.headers.get('retry-after'),
  );
  const retryAfter = bodyRetryAfter ?? headerRetryAfter ?? 0.25;
  const retryAfterMs = retryAfter > 50 ? retryAfter : retryAfter * 1_000;

  return Math.min(
    Math.max(Math.ceil(retryAfterMs), 100),
    DISCORD_MAX_RETRY_DELAY_MS,
  );
}

function readNumericRetryAfter(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
