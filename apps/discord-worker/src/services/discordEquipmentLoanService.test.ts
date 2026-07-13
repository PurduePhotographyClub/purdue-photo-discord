import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Env } from '../discord/types';
import type { EquipmentLoanSyncInternalEvent } from '../internal-events/types';
import { syncEquipmentLoanChannel } from './discordEquipmentLoanService';
import { sendDiscordMessage } from './discordMessageService';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('equipment reminder sync reports failure when every delivery fails', async () => {
  let directMessageAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';

    if (method === 'PUT' && url.pathname.includes('/permissions/')) {
      return new Response(null, { status: 204 });
    }
    if (method === 'PATCH' && url.pathname.endsWith('/messages/message-123')) {
      return Response.json({ id: 'message-123' });
    }
    if (method === 'GET' && url.pathname.endsWith('/messages')) {
      return Response.json({ message: 'unavailable' }, { status: 500 });
    }
    if (method === 'POST' && url.pathname.endsWith('/users/@me/channels')) {
      directMessageAttempts += 1;
      return Response.json({ message: 'unavailable' }, { status: 500 });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  const result = await syncEquipmentLoanChannel(
    createEnv(),
    createReminderEvent(),
  );

  assert.deepEqual(result, {
    channelId: 'channel-123',
    messageId: 'message-123',
    reminderDelivered: false,
    staleChannel: false,
  });
  assert.equal(directMessageAttempts, 1);
});

test('equipment reminder succeeds by DM and clears a missing channel', async () => {
  const messageBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';

    if (
      method === 'GET' &&
      url.pathname === '/api/v10/channels/channel-123/messages'
    ) {
      return Response.json([]);
    }
    if (
      method === 'POST' &&
      url.pathname === '/api/v10/channels/channel-123/messages'
    ) {
      messageBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return Response.json({ message: 'unknown channel' }, { status: 404 });
    }
    if (method === 'POST' && url.pathname.endsWith('/users/@me/channels')) {
      return Response.json({ id: 'dm-channel-123' });
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/v10/channels/dm-channel-123/messages'
    ) {
      return Response.json([]);
    }
    if (
      method === 'POST' &&
      url.pathname === '/api/v10/channels/dm-channel-123/messages'
    ) {
      messageBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return Response.json({ id: 'dm-message-123' });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  const result = await syncEquipmentLoanChannel(
    createEnv(),
    createReminderEvent(),
  );

  assert.deepEqual(result, {
    channelId: null,
    messageId: null,
    reminderDelivered: true,
    staleChannel: true,
  });
  assert.equal(messageBodies.length, 2);
  assert.equal(
    messageBodies.every(
      (body) => body.enforce_nonce === true && typeof body.nonce === 'string',
    ),
    true,
  );
});

test('equipment reminder without a channel delivers by DM without creating one', async () => {
  let guildChannelCreates = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.pathname.endsWith('/guild-123/channels')) {
      guildChannelCreates += 1;
      return Response.json({ id: 'unexpected-loan-channel' });
    }
    if (method === 'POST' && url.pathname.endsWith('/users/@me/channels')) {
      return Response.json({ id: 'dm-channel-123' });
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/v10/channels/dm-channel-123/messages'
    ) {
      return Response.json([]);
    }
    if (
      method === 'POST' &&
      url.pathname === '/api/v10/channels/dm-channel-123/messages'
    ) {
      return Response.json({ id: 'dm-message-123' });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  const result = await syncEquipmentLoanChannel(createEnv(), {
    ...createReminderEvent(),
    channelId: null,
    messageId: null,
  });

  assert.deepEqual(result, {
    channelId: null,
    messageId: null,
    reminderDelivered: true,
    staleChannel: false,
  });
  assert.equal(guildChannelCreates, 0);
});

test('a lender-only DM reports that the primary reminder was not delivered', async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.pathname.endsWith('/users/@me/channels')) {
      const body = JSON.parse(String(init?.body)) as { recipient_id?: string };
      return body.recipient_id === 'borrower-123'
        ? Response.json({ message: 'dm closed' }, { status: 500 })
        : Response.json({ id: 'lender-dm-channel' });
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/v10/channels/lender-dm-channel/messages'
    ) {
      return Response.json([]);
    }
    if (
      method === 'POST' &&
      url.pathname === '/api/v10/channels/lender-dm-channel/messages'
    ) {
      return Response.json({ id: 'lender-dm-message' });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  const result = await syncEquipmentLoanChannel(createEnv(), {
    ...createReminderEvent(),
    channelId: null,
    lender: {
      discordId: 'lender-123',
      name: 'Lender',
      userId: 'lender-user-123',
    },
    messageId: null,
  });

  assert.deepEqual(result, {
    channelId: null,
    messageId: null,
    reminderDelivered: false,
    staleChannel: false,
  });
});

test('a stale channel is reported even when the borrower delivery fails', async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';

    if (
      method === 'GET' &&
      url.pathname === '/api/v10/channels/channel-123/messages'
    ) {
      return Response.json({ message: 'unknown channel' }, { status: 404 });
    }
    if (method === 'POST' && url.pathname.endsWith('/users/@me/channels')) {
      return Response.json({ message: 'dm closed' }, { status: 500 });
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  const result = await syncEquipmentLoanChannel(
    createEnv(),
    createReminderEvent(),
  );

  assert.deepEqual(result, {
    channelId: null,
    messageId: null,
    reminderDelivered: false,
    staleChannel: true,
  });
});

test('nonce-bearing messages reconcile an ambiguous Discord delivery after posting', async () => {
  let postAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.pathname.endsWith('/messages')) {
      postAttempts += 1;
      throw new Error('Connection closed after request upload');
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/v10/channels/channel-123/messages'
    ) {
      assert.equal(url.searchParams.get('limit'), '100');
      return Response.json([
        {
          author: { bot: true, id: 'application-123' },
          id: 'existing-message',
          nonce: 'stable-reminder-nonce',
        },
      ]);
    }
    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  const result = await sendDiscordMessage(createEnv(), {
    channelId: 'channel-123',
    content: 'Reminder',
    nonce: 'stable-reminder-nonce',
  });

  assert.deepEqual(result, {
    author: { bot: true, id: 'application-123' },
    id: 'existing-message',
    nonce: 'stable-reminder-nonce',
  });
  assert.equal(postAttempts, 1);
});

test('nonce reconciliation never adopts another author message', async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.pathname.endsWith('/messages')) {
      throw new Error('Connection closed after request upload');
    }
    if (method === 'GET' && url.pathname.endsWith('/messages')) {
      return Response.json([
        {
          author: { bot: false, id: 'foreign-user' },
          id: 'foreign-message',
          nonce: 'stable-reminder-nonce',
        },
      ]);
    }

    throw new Error(`Unexpected Discord API call: ${method} ${url.pathname}`);
  };

  await assert.rejects(
    sendDiscordMessage(createEnv(), {
      channelId: 'channel-123',
      content: 'Reminder',
      nonce: 'stable-reminder-nonce',
    }),
    /Connection closed after request upload/,
  );
});

function createEnv(): Env {
  return {
    DISCORD_TOKEN: 'test-discord-token',
    DISCORD_GUILD_ID: 'guild-123',
    DISCORD_APPLICATION_ID: 'application-123',
  };
}

function createReminderEvent(): EquipmentLoanSyncInternalEvent {
  return {
    borrower: {
      discordId: 'borrower-123',
      name: 'Borrower',
      userId: 'user-123',
    },
    channelId: 'channel-123',
    dueDate: '2026-07-13T12:00:00.000Z',
    equipment: {
      assetTag: 'CAM-1',
      category: 'camera',
      id: 'equipment-123',
      model: 'Model',
      name: 'Camera',
    },
    isPpcOwned: true,
    lender: null,
    loanId: 'loan-123',
    messageId: 'message-123',
    notes: null,
    reminderKind: 'due_soon',
    requestedAt: '2026-07-01T12:00:00.000Z',
    approvedAt: '2026-07-02T12:00:00.000Z',
    returnedAt: null,
    status: 'active',
    termsSnapshot: null,
    type: 'website.equipment.loan.sync',
    updateChannel: false,
  };
}
