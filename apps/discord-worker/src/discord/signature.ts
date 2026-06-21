/**
 * Discord request verification.
 *
 * This is the trust boundary for interaction requests. Nothing should parse or
 * dispatch Discord payloads until this module has checked the Ed25519 signature.
 */
import { verifyKey } from 'discord-interactions';
import type { DiscordInteraction, Env } from './types';
import { getRequiredEnv } from '../utils/env';

export type DiscordRequestVerification =
  | {
      ok: true;
      interaction: DiscordInteraction;
    }
  | {
      ok: false;
      message: string;
      status: number;
    };

export async function verifyDiscordRequest(
  request: Request,
  env: Env,
): Promise<DiscordRequestVerification> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  // Read the body exactly once and verify that byte-for-byte string. Re-parsing
  // or rebuilding JSON before verifyKey would break Discord's signature check.
  const body = await request.text();

  if (!signature || !timestamp) {
    return {
      ok: false,
      message: 'Missing Discord request signature.',
      status: 401,
    };
  }

  const publicKey = getRequiredEnv(env, 'DISCORD_PUBLIC_KEY');
  const isValid = await verifyKey(body, signature, timestamp, publicKey);

  if (!isValid) {
    return {
      ok: false,
      message: 'Bad request signature.',
      status: 401,
    };
  }

  // Parsing happens only after the signature is trusted, keeping malformed or
  // spoofed payloads out of the normal interaction dispatcher.
  const interaction = parseDiscordInteraction(body);

  if (!interaction) {
    return {
      ok: false,
      message: 'Invalid Discord interaction payload.',
      status: 400,
    };
  }

  return {
    ok: true,
    interaction,
  };
}

function parseDiscordInteraction(body: string): DiscordInteraction | undefined {
  // Return undefined instead of throwing so the route can send a clean 400.
  try {
    const payload = JSON.parse(body) as unknown;

    if (!isRecord(payload) || typeof payload.type !== 'number') {
      return undefined;
    }

    return payload as unknown as DiscordInteraction;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // Avoid reading fields from arrays/null/primitive JSON.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
