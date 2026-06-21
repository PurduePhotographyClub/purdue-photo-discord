const SIGNATURE_PREFIX = 'sha256=';

export async function signInternalRequest(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(
      createSignaturePayload(method, path, timestamp, body),
    ),
  );

  return `${SIGNATURE_PREFIX}${toHex(signature)}`;
}

function createSignaturePayload(
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string {
  return [method.toUpperCase(), path, timestamp, body].join('\n');
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
