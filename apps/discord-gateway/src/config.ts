/**
 * Turns the VPS env file into typed Gateway config.
 *
 * Keep raw process.env access here. The rest of the Gateway should receive
 * already-validated values, especially for Discord intents and HTTP settings.
 */
import process from 'node:process';
import { ActivityType, GatewayIntentBits, Partials } from 'discord.js';

export interface GatewayConfig {
  activityName: string | undefined;
  activityType: number;
  discordToken: string;
  forwardBotEvents: boolean;
  forwardMembers: boolean;
  forwardMessageContent: boolean;
  forwardMessages: boolean;
  forwardReactions: boolean;
  gatewayIp: string;
  httpServer: GatewayHttpServerConfig;
  intents: GatewayIntentBits[];
  partials: Partials[];
  status: GatewayPresenceStatus;
  workerSecret: string;
  workerInternalEventUrl: string;
  filters: {
    channelIds: ReadonlySet<string>;
    guildIds: ReadonlySet<string>;
  };
}

export interface GatewayHttpServerConfig {
  host: string;
  port: number;
}

export type GatewayPresenceStatus = 'dnd' | 'idle' | 'invisible' | 'online';

export function readGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  // Build the full config once at startup so the rest of the app can work with
  // typed values instead of repeatedly poking at process.env.
  // Feature flags drive both Discord subscription scope and forwarding behavior,
  // keeping privileged intents off unless the process actually needs them.
  const forwardReactions = readBoolean(env, 'FORWARD_REACTION_EVENTS', true);
  const forwardMessages = readBoolean(env, 'FORWARD_MESSAGE_EVENTS', false);
  const forwardMembers = readBoolean(env, 'FORWARD_MEMBER_EVENTS', false);
  const forwardMessageContent = readBoolean(
    env,
    'FORWARD_MESSAGE_CONTENT',
    false,
  );

  return {
    activityName: readOptionalString(env, 'DISCORD_ACTIVITY_NAME'),
    activityType:
      readOptionalInteger(env, 'DISCORD_ACTIVITY_TYPE') ?? ActivityType.Playing,
    discordToken: readRequiredString(env, 'DISCORD_TOKEN'),
    filters: {
      channelIds: readStringSet(env, 'FORWARD_CHANNEL_IDS'),
      guildIds: readStringSet(env, 'FORWARD_GUILD_IDS'),
    },
    forwardBotEvents: readBoolean(env, 'FORWARD_BOT_EVENTS', false),
    forwardMembers,
    forwardMessageContent,
    forwardMessages,
    forwardReactions,
    gatewayIp: readRequiredString(env, 'GATEWAY_IP'),
    httpServer: readHttpServerConfig(env),
    intents: computeGatewayIntents({
      forwardMembers,
      forwardMessageContent,
      forwardMessages,
      forwardReactions,
    }),
    partials: computePartials({ forwardReactions }),
    status: readPresenceStatus(env, 'DISCORD_GATEWAY_STATUS', 'online'),
    workerSecret: readRequiredString(env, 'WORKER_SECRET'),
    workerInternalEventUrl: readWorkerInternalEventUrl(env),
  };
}

function computeGatewayIntents(options: {
  forwardMembers: boolean;
  forwardMessageContent: boolean;
  forwardMessages: boolean;
  forwardReactions: boolean;
}): GatewayIntentBits[] {
  // Start with the one intent every guild bot needs, then opt into the event
  // families that deployment config actually enables.
  const intents = new Set<GatewayIntentBits>([GatewayIntentBits.Guilds]);

  if (options.forwardReactions) {
    // Reaction payloads include message/channel context, so discord.js needs the
    // messages intent alongside the reaction intent.
    intents.add(GatewayIntentBits.GuildMessages);
    intents.add(GatewayIntentBits.GuildMessageReactions);
  }

  if (options.forwardMessages) {
    intents.add(GatewayIntentBits.GuildMessages);
  }

  if (options.forwardMembers) {
    intents.add(GatewayIntentBits.GuildMembers);
  }

  if (options.forwardMessages && options.forwardMessageContent) {
    intents.add(GatewayIntentBits.MessageContent);
  }

  return [...intents];
}

function computePartials(options: { forwardReactions: boolean }): Partials[] {
  // Partials are only useful for reaction forwarding. Leaving them off otherwise
  // keeps discord.js payloads a little simpler.
  if (!options.forwardReactions) {
    return [];
  }

  // Reactions may arrive for uncached messages/users after a restart. Partials
  // let the gateway forward the IDs it has instead of dropping the event.
  return [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User];
}

function readWorkerInternalEventUrl(env: NodeJS.ProcessEnv): string {
  // Support either a full internal event URL or a base Worker URL. The full URL
  // is handy for custom routing; the base URL keeps normal deploy config short.
  const explicitUrl = readOptionalString(env, 'WORKER_INTERNAL_EVENT_URL');

  if (explicitUrl) {
    return validateHttpUrl(explicitUrl, 'WORKER_INTERNAL_EVENT_URL');
  }

  // Most deploys only need the Worker base URL; the internal route is stable.
  const baseUrl = validateHttpUrl(
    readRequiredString(env, 'WORKER_BASE_URL'),
    'WORKER_BASE_URL',
  );

  return new URL('/internal/events', baseUrl).toString();
}

function readHttpServerConfig(env: NodeJS.ProcessEnv): GatewayHttpServerConfig {
  // GATEWAY_HEALTH_* is kept as a compatibility alias from when the HTTP server
  // only exposed /health. New deploys should use GATEWAY_*.
  const port =
    readOptionalPort(env, 'GATEWAY_PORT') ??
    readOptionalPort(env, 'GATEWAY_HEALTH_PORT') ??
    8788;

  return {
    host:
      readOptionalString(env, 'GATEWAY_HOST') ??
      readOptionalString(env, 'GATEWAY_HEALTH_HOST') ??
      '0.0.0.0',
    port,
  };
}

function readRequiredString(env: NodeJS.ProcessEnv, key: string): string {
  // Fail loudly during boot. A missing secret is easier to fix before the bot
  // connects to Discord than after it is half-running.
  const value = readOptionalString(env, key);

  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

function readOptionalString(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  // Treat whitespace-only env values as unset. This avoids a blank value looking
  // like real configuration because systemd/env files can hide extra spaces.
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readBoolean(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: boolean,
): boolean {
  // Accept the common forms people actually type into env files.
  const value = readOptionalString(env, key);

  if (!value) {
    return defaultValue;
  }

  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) {
    return false;
  }

  throw new Error(`${key} must be a boolean value.`);
}

function readOptionalInteger(
  env: NodeJS.ProcessEnv,
  key: string,
): number | undefined {
  // Integers are used for enum-like values and ports, so decimals and negatives
  // are almost certainly config mistakes.
  const value = readOptionalString(env, key);

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }

  return parsed;
}

function readOptionalPort(
  env: NodeJS.ProcessEnv,
  key: string,
): number | undefined {
  // Keep port validation separate from integer parsing so the error message says
  // exactly what was wrong.
  const port = readOptionalInteger(env, key);

  if (port === undefined) {
    return undefined;
  }

  if (port < 1 || port > 65_535) {
    throw new Error(`${key} must be a TCP port between 1 and 65535.`);
  }

  return port;
}

function readPresenceStatus(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: GatewayPresenceStatus,
): GatewayPresenceStatus {
  // Discord only accepts this small status set for bot presence.
  const value = readOptionalString(env, key);

  if (!value) {
    return defaultValue;
  }

  if (
    value === 'dnd' ||
    value === 'idle' ||
    value === 'invisible' ||
    value === 'online'
  ) {
    return value;
  }

  throw new Error(`${key} must be one of: online, idle, dnd, invisible.`);
}

function readStringSet(
  env: NodeJS.ProcessEnv,
  key: string,
): ReadonlySet<string> {
  // Comma-separated ID lists keep the env file simple while giving the forwarder
  // constant-time membership checks.
  const value = readOptionalString(env, key);

  if (!value) {
    return new Set();
  }

  return new Set(
    value.split(',').flatMap((item) => {
      const trimmedItem = item.trim();
      return trimmedItem ? [trimmedItem] : [];
    }),
  );
}

function validateHttpUrl(value: string, key: string): string {
  // Normalize through URL so later code receives one consistent string shape.
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${key} must use http or https.`);
  }

  return url.toString();
}
