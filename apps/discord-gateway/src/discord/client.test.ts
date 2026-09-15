import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDiscordGatewayHealthy } from './client.js';
import { readGatewayConfig } from '../config.js';
import { WorkerEventForwarder } from './forwarder.js';
import type { Logger } from '../utils/logger.js';

const silentLogger: Logger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

test('gateway health fails closed when enabled scam moderation is not ready', () => {
  assert.equal(
    isDiscordGatewayHealthy('ready', {
      enabled: true,
      handledCount: 0,
      lastFailure: 'The verified role is missing.',
      ready: false,
    }),
    false,
  );
  assert.equal(
    isDiscordGatewayHealthy('ready', {
      enabled: true,
      handledCount: 0,
      ready: true,
    }),
    true,
  );
  assert.equal(
    isDiscordGatewayHealthy('ready', {
      enabled: false,
      handledCount: 0,
      ready: false,
    }),
    true,
  );
});

test('gateway forwards bounded competition post details only from competition categories', async () => {
  const config = readGatewayConfig({
    DISCORD_TOKEN: 'test-token',
    WORKER_INTERNAL_EVENT_URL: 'https://worker.test/internal/events',
    WORKER_SECRET: 'test-worker-secret',
  });
  const deliveries: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    deliveries.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ ok: true });
  };

  try {
    const forwarder = new WorkerEventForwarder(config, silentLogger);
    await forwarder.forward(
      'MESSAGE_CREATE',
      {
        attachments: [
          {
            content_type: 'image/jpeg',
            filename: 'one.jpg',
            url: 'https://cdn.discordapp.com/one.jpg',
          },
          {
            content_type: 'image/jpeg',
            filename: 'two.jpg',
            url: 'https://cdn.discordapp.com/two.jpg',
          },
          {
            content_type: 'image/jpeg',
            filename: 'three.jpg',
            url: 'https://cdn.discordapp.com/three.jpg',
          },
        ],
        author: { bot: false, global_name: 'Member', id: '123456789012345678' },
        category_id: '1512508504081039482',
        channel_id: '223456789012345678',
        content: 'A short description.',
        guild_id: '1182061172309106708',
        id: '223456789012345678',
        parent_channel_id: '323456789012345678',
        thread_name: 'Photo title',
      },
      '423456789012345678',
    );
    await forwarder.forward(
      'MESSAGE_CREATE',
      {
        author: { bot: false, id: '123456789012345678' },
        category_id: '523456789012345678',
        channel_id: '623456789012345678',
        content: 'Do not forward this.',
        guild_id: '1182061172309106708',
        id: '623456789012345678',
      },
      '423456789012345678',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(deliveries.length, 1);
  const payload = deliveries[0]?.payload as Record<string, unknown>;
  assert.equal(payload.content, 'A short description.');
  assert.equal((payload.attachments as unknown[]).length, 2);
  assert.equal(payload.category_id, '1512508504081039482');
});
