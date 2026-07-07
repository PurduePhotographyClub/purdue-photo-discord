import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { InteractionResponseFlags } from 'discord-interactions';
import { commands, getCommand } from '../../../config/commands';
import { DISCORD_ROLE_IDS } from '../../config/discord-role-ids';
import type { ApplicationCommandInteraction, Env } from '../../discord/types';

const HONEYPOT_CHANNEL_ID = '1519110560925483008';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('/post-honeypot-warning is registered with the Discord command registry', () => {
  assert.ok(
    commands.some(
      (command) => command.definition.name === 'post-honeypot-warning',
    ),
  );
  assert.equal(
    getCommand('POST-HONEYPOT-WARNING')?.definition.name,
    'post-honeypot-warning',
  );
});

test('/post-honeypot-warning denies callers without the Executive role', async () => {
  const command = getCommand('post-honeypot-warning');
  assert.ok(command);

  const response = await command.execute(
    createInteraction({ roles: [] }),
    createEnv(),
  );

  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
  assert.equal(
    response.data?.content,
    'Only the Executive role can use this command.',
  );
});

test('/post-honeypot-warning allows the Executive role', async () => {
  let requestedPath = '';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requestedPath = `${init?.method ?? 'GET'} ${url.pathname}`;
    return Response.json({ id: 'warning-message' });
  };

  const command = getCommand('post-honeypot-warning');
  assert.ok(command);

  const response = await command.execute(
    createInteraction({ roles: [DISCORD_ROLE_IDS.executive] }),
    createEnv(),
  );

  assert.equal(
    requestedPath,
    `POST /api/v10/channels/${HONEYPOT_CHANNEL_ID}/messages`,
  );
  assert.equal(response.data?.flags, InteractionResponseFlags.EPHEMERAL);
  assert.equal(
    response.data?.content,
    `Honeypot warning posted in <#${HONEYPOT_CHANNEL_ID}> as warning-message.`,
  );
});

function createEnv(): Env {
  return {
    DISCORD_TOKEN: 'test-discord-token',
  };
}

function createInteraction(input: {
  roles: string[];
}): ApplicationCommandInteraction {
  return {
    data: {
      name: 'post-honeypot-warning',
    },
    member: {
      roles: input.roles,
      user: {
        id: 'admin-user',
      },
    },
    type: 2,
  } as ApplicationCommandInteraction;
}
