import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimGatewayRequestNonce,
  requestWebsiteApi,
} from './websiteApiService';
import type { Env } from '../discord/types';

function createEnv(response: Response, requests: Request[]): Env {
  return {
    API_WORKER: {
      fetch: async (request) => {
        requests.push(
          request instanceof Request ? request : new Request(request),
        );
        return response;
      },
      connect: () => {
        throw new Error('Socket connections are not used by this test.');
      },
    },
    INTERNAL_TOKEN: 'test-internal-token',
  };
}

test('claims a new gateway nonce through the private API route', async () => {
  const requests: Request[] = [];
  const claimed = await claimGatewayRequestNonce(
    createEnv(Response.json({ claimed: true }, { status: 201 }), requests),
    'nonce-1',
  );

  assert.equal(claimed, true);
  assert.equal(
    requests[0]?.url,
    'https://api.internal/internal/gateway-nonces',
  );
  assert.equal(
    requests[0]?.headers.get('x-pcc-internal-source'),
    'discord-worker',
  );
  assert.equal(
    requests[0]?.headers.get('x-internal-token'),
    'test-internal-token',
  );
});

test('reports a replayed gateway nonce without converting it into an API outage', async () => {
  const replayed = await claimGatewayRequestNonce(
    createEnv(Response.json({ claimed: false }, { status: 409 }), []),
    'nonce-1',
  );

  assert.equal(replayed, false);
});

test('scopes authenticated API requests to a validated Discord actor', async () => {
  const requests: Request[] = [];
  const actorDiscordId = '123456789012345678';
  await requestWebsiteApi(
    createEnv(Response.json({ ok: true }), requests),
    '/event-carpools/by-discord',
    { body: { actorDiscordId }, method: 'POST' },
  );

  assert.equal(
    requests[0]?.headers.get('x-pcc-actor-discord-id'),
    actorDiscordId,
  );
});
