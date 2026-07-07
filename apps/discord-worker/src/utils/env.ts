/**
 * Worker environment helpers.
 *
 * These functions normalize empty strings, placeholders, URLs, and compatibility
 * aliases before route or service code uses configuration.
 */
import type { Env } from '../discord/types';
import { ConfigError } from './errors';

type EnvKey = keyof Env & string;

export type UrlEnvResult =
  | { status: 'configured'; url: string }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

const GATEWAY_SERVICE_ORIGIN = 'http://gateway.internal';

export function getRequiredEnv(env: Env, key: EnvKey): string {
  // Required values throw ConfigError so callers get a consistent Worker error.
  const value = getOptionalEnv(env, key);

  if (!value) {
    throw new ConfigError(`${key} is not configured.`);
  }

  return value;
}

export function getOptionalEnv(env: Env, key: EnvKey): string | undefined {
  // Wrangler may pass empty strings for optional vars; treat them as missing.
  const value = env[key];

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getOptionalUrlEnv(env: Env, key: EnvKey): UrlEnvResult {
  // URL-shaped config returns state instead of throwing so health checks can
  // report configuration problems without crashing the command.
  const value = getOptionalEnv(env, key);

  // The website repo can use "local" as a placeholder; treat it like missing so
  // health checks do not try to fetch an unusable production URL.
  if (!value || value.toLowerCase() === 'local') {
    return { status: 'missing' };
  }

  try {
    const url = new URL(value);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { status: 'invalid', reason: `${key} must use http or https.` };
    }

    return { status: 'configured', url: url.toString().replace(/\/$/, '') };
  } catch {
    return { status: 'invalid', reason: `${key} must be a valid URL.` };
  }
}

export function getGatewayServiceUrl(path: string): string {
  // Workers VPC requires an absolute URL, but the VPC Service binding decides
  // the real tunnel target. Keep this host synthetic so no VPS IP leaks into
  // Worker code or logs.
  return new URL(path, GATEWAY_SERVICE_ORIGIN).toString();
}

export function hasWorkerSecret(env: Env): boolean {
  // Used by /health to show whether the Gateway and Worker can authenticate.
  return Boolean(getWorkerSecret(env));
}

export function getWorkerSecret(env: Env): string | undefined {
  return getOptionalEnv(env, 'WORKER_SECRET');
}
