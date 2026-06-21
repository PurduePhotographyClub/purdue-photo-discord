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

export function getGatewayEndpointEnv(env: Env, path: string): UrlEnvResult {
  // GATEWAY_HEALTH_* remains as a temporary compatibility alias from the first
  // Gateway health implementation.
  const ip =
    getOptionalEnv(env, 'GATEWAY_IP') ??
    getOptionalEnv(env, 'GATEWAY_HEALTH_IP');

  if (!ip) {
    return { status: 'missing' };
  }

  const portValue =
    getOptionalEnv(env, 'GATEWAY_PORT') ??
    getOptionalEnv(env, 'GATEWAY_HEALTH_PORT') ??
    '8788';
  const port = Number(portValue);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return {
      reason: 'GATEWAY_PORT must be a TCP port between 1 and 65535.',
      status: 'invalid',
    };
  }

  try {
    return {
      status: 'configured',
      url: new URL(path, `http://${formatHost(ip)}:${port}`).toString(),
    };
  } catch {
    return {
      reason: 'GATEWAY_IP must be a valid IP address or hostname.',
      status: 'invalid',
    };
  }
}

export function getGatewayHealthEndpointEnv(env: Env): UrlEnvResult {
  // Health is just another Gateway HTTP route from the Worker's perspective.
  return getGatewayEndpointEnv(env, '/health');
}

export function hasWorkerSecret(env: Env): boolean {
  // Used by /health to show whether the Gateway and Worker can authenticate.
  return Boolean(getWorkerSecret(env));
}

export function getWorkerSecret(env: Env): string | undefined {
  return getOptionalEnv(env, 'WORKER_SECRET');
}

function formatHost(host: string): string {
  // IPv6 hosts need brackets before adding ":port".
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
