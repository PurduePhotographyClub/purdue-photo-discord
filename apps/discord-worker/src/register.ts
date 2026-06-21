/**
 * Local command registration script.
 *
 * Run this from the Worker workspace when slash-command definitions change.
 * It mirrors the Worker env shape because this file runs under Node, not
 * Cloudflare's runtime.
 */
import process from 'node:process';
import { commandDefinitions } from '../config/commands';
import {
  type CommandRegistrationOptions,
  registerApplicationCommands,
} from './discord/api';
import type { Env } from './discord/types';
import { isAppError } from './utils/errors';

// This script runs under Node, not inside Wrangler, so mirror only the Worker
// bindings needed by command registration and shared Discord API helpers.
const env = readNodeEnv();
const options = readCommandRegistrationOptions(process.argv.slice(2));

try {
  const result = await registerApplicationCommands(
    env,
    commandDefinitions,
    options,
  );
  console.log(
    result.registeredScope === 'guild'
      ? `Registered Discord guild commands for ${options.guildId ?? env.DISCORD_GUILD_ID}:`
      : 'Registered Discord global commands:',
  );
  console.log(JSON.stringify(result.registered, null, 2));

  for (const cleanup of result.cleanup) {
    console.log(`Cleared stale Discord ${cleanup.scope} commands.`);
  }
} catch (error) {
  console.error('Failed to register Discord commands.');

  if (isAppError(error)) {
    console.error(`${error.code}: ${error.message}`);

    if (error.details) {
      console.error(JSON.stringify(error.details, null, 2));
    }
  } else if (error instanceof Error) {
    console.error(error.message);
  }

  process.exitCode = 1;
}

function readCommandRegistrationOptions(
  args: string[],
): CommandRegistrationOptions {
  const options: CommandRegistrationOptions = {};
  let cleanupOpposite = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    const [name, inlineValue] = arg.split('=', 2);
    const nextValue = inlineValue ?? args[index + 1];

    if (name === '--scope') {
      if (
        nextValue !== 'auto' &&
        nextValue !== 'global' &&
        nextValue !== 'guild'
      ) {
        throw new Error('--scope must be auto, global, or guild.');
      }

      options.scope = nextValue;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    if (name === '--guild-id') {
      if (!nextValue?.trim()) {
        throw new Error('--guild-id requires a Discord guild ID.');
      }

      options.guildId = nextValue;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    if (arg === '--cleanup-global') {
      options.cleanupGlobal = true;
      continue;
    }

    if (arg === '--cleanup-guild') {
      options.cleanupGuild = true;
      continue;
    }

    if (arg === '--cleanup-opposite') {
      cleanupOpposite = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (cleanupOpposite) {
    if (options.scope === 'global') {
      options.cleanupGuild = true;
    } else {
      options.cleanupGlobal = true;
    }
  }

  return options;
}

function readNodeEnv(): Env {
  // Keep this list explicit so command registration does not accidentally depend
  // on unrelated local environment variables.
  return {
    DISCORD_APPLICATION_ID: process.env.DISCORD_APPLICATION_ID,
    DISCORD_DEFAULT_CHANNEL_ID: process.env.DISCORD_DEFAULT_CHANNEL_ID,
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
    DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DISCORD_UNVERIFIED_ROLE_ID: process.env.DISCORD_UNVERIFIED_ROLE_ID,
    DISCORD_VERIFICATION_CHANNEL_ID:
      process.env.DISCORD_VERIFICATION_CHANNEL_ID,
    DISCORD_VERIFIED_ROLE_ID: process.env.DISCORD_VERIFIED_ROLE_ID,
    DISCORD_WIKI_CHANNEL_ID: process.env.DISCORD_WIKI_CHANNEL_ID,
    GATEWAY_IP: process.env.GATEWAY_IP,
    GATEWAY_PORT: process.env.GATEWAY_PORT,
    GATEWAY_HEALTH_IP: process.env.GATEWAY_HEALTH_IP,
    GATEWAY_HEALTH_PORT: process.env.GATEWAY_HEALTH_PORT,
    INTERNAL_TOKEN: process.env.INTERNAL_TOKEN,
    WEBSITE_URL: process.env.WEBSITE_URL,
    WORKER_SECRET: process.env.WORKER_SECRET,
    WIKI_URL: process.env.WIKI_URL,
  };
}
