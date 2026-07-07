import assert from 'node:assert/strict';
import test from 'node:test';
import type { Env } from '../discord/types';
import { updateGatewayPresence } from './gatewayApiService';

test('updateGatewayPresence prefers the Gateway VPC service binding', async () => {
  let gatewayServiceUrl: string | undefined;
  const env: Env = {
    GATEWAY_SERVICE: {
      fetch: async (input) => {
        gatewayServiceUrl = String(input);
        return Response.json({
          ok: true,
          status: 'idle',
          updatedAt: '2026-07-07T00:00:00.000Z',
        });
      },
    },
    WORKER_SECRET: 'test-secret',
  };

  const snapshot = await updateGatewayPresence(env, { status: 'idle' });

  assert.equal(gatewayServiceUrl, 'http://gateway.internal/presence');
  assert.equal(snapshot.status, 'idle');
});

test('updateGatewayPresence requires the Gateway VPC service binding', async () => {
  const env: Env = {
    WORKER_SECRET: 'test-secret',
  };

  await assert.rejects(
    () => updateGatewayPresence(env, { status: 'dnd' }),
    /GATEWAY_SERVICE VPC binding is not configured/,
  );
});
