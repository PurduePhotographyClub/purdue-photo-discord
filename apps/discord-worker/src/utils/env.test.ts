import assert from 'node:assert/strict';
import test from 'node:test';
import { getGatewayServiceUrl } from './env';

test('getGatewayServiceUrl returns an absolute synthetic VPC URL', () => {
  assert.equal(
    getGatewayServiceUrl('/health'),
    'http://gateway.internal/health',
  );
});
