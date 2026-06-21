/**
 * Signs Gateway-to-Worker requests.
 *
 * The Cloudflare Worker verifies this HMAC, checks the timestamp, and rejects
 * replayed nonces through KV.
 */
import { createHmac, randomUUID } from 'node:crypto';

const SIGNATURE_HEADER = 'x-pccbot-signature';
const TIMESTAMP_HEADER = 'x-pccbot-timestamp';
const NONCE_HEADER = 'x-pccbot-nonce';

export function createSignedWorkerHeaders(options: {
  body: string;
  method: string;
  path: string;
  secret: string;
}): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = createHmac('sha256', options.secret)
    .update(
      [
        options.method.toUpperCase(),
        options.path,
        timestamp,
        nonce,
        options.body,
      ].join('\n'),
    )
    .digest('hex');

  return {
    [NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: `sha256=${signature}`,
    [TIMESTAMP_HEADER]: timestamp,
  };
}
