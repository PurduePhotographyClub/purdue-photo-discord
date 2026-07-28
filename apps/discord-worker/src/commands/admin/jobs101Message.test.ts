import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  InteractionResponseFlags,
  InteractionType,
} from 'discord-interactions';
import { DISCORD_ROLE_IDS } from '../../config/discord-role-ids';
import type { ApplicationCommandInteraction, Env } from '../../discord/types';
import { getCommand } from '../../commands';
import { JOBS_101_MESSAGE_CHANNEL_ID } from '../../services/discordJobsAccessService';
import { jobs101MessageCommand } from './jobs101Message';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('jobs-101-message is registered case-insensitively', () => {
  assert.equal(getCommand('JOBS-101-MESSAGE'), jobs101MessageCommand);
});

test('only Executives can post the Jobs 101 messages', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return Response.json({ id: 'unexpected-message' });
  };

  const response = await jobs101MessageCommand.execute(
    commandInteraction([]),
    createEnv(),
  );

  assert.equal(requestCount, 0);
  assert.equal(
    response.data?.content,
    'Only the Executive role can use this command.',
  );
  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
});

test('an Executive can post Jobs 101 to the configured channel', async () => {
  const requestedPaths: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requestedPaths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return Response.json({ id: `message-${requestedPaths.length}` });
  };

  const response = await jobs101MessageCommand.execute(
    commandInteraction([DISCORD_ROLE_IDS.executive]),
    createEnv(),
  );

  assert.equal(requestedPaths.length > 1, true);
  assert.equal(
    requestedPaths.every(
      (request) =>
        request ===
        `POST /api/v10/channels/${JOBS_101_MESSAGE_CHANNEL_ID}/messages`,
    ),
    true,
  );
  assert.match(
    response.data?.content ?? '',
    new RegExp(`Jobs 101 posted in <#${JOBS_101_MESSAGE_CHANNEL_ID}>`),
  );
  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
});

test('Jobs 101 posting failures return an ephemeral command error', async () => {
  globalThis.fetch = async () =>
    Response.json({ message: 'Missing Access' }, { status: 403 });

  const response = await jobs101MessageCommand.execute(
    commandInteraction([DISCORD_ROLE_IDS.executive]),
    createEnv(),
  );

  assert.match(
    response.data?.content ?? '',
    /^Could not post Jobs 101: Discord API request failed with 403\./,
  );
  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
});

function commandInteraction(roles: string[]): ApplicationCommandInteraction {
  return {
    data: { name: 'jobs-101-message' },
    member: {
      roles,
      user: { id: 'executive-123' },
    },
    type: InteractionType.APPLICATION_COMMAND,
  };
}

function createEnv(): Env {
  return {
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_TOKEN: 'discord-token',
  };
}
