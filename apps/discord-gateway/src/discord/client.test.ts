import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDiscordGatewayHealthy } from './client.js';

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
