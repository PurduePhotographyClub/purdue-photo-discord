/**
 * Collects health data for the Discord /health command.
 *
 * Missing config is treated differently from downtime so local development and
 * partial deploys can still report useful status.
 */
import type { Env } from '../discord/types';
import {
  getGatewayServiceUrl,
  getOptionalUrlEnv,
  type UrlEnvResult,
} from '../utils/env';
import { getErrorMessage } from '../utils/errors';

export type ServiceHealthStatus =
  | 'online'
  | 'offline'
  | 'not_configured'
  | 'invalid_config';

export interface ServiceHealthCheck {
  name: string;
  status: ServiceHealthStatus;
  url?: string;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
}

export interface SystemHealthReport {
  checkedAt: string;
  checks: {
    website: ServiceHealthCheck;
    gateway: ServiceHealthCheck;
    api: ServiceHealthCheck;
    dashboard: ServiceHealthCheck;
    wiki: ServiceHealthCheck;
  };
  comingSoonPages: string[];
  hasFailures: boolean;
  hasInvalidConfig: boolean;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const CHECK_TIMEOUT_MS = 4_000;
const COMING_SOON_PAGES = [{ name: 'Exposure Triangle', path: '/exposure' }];

export async function getSystemHealth(
  env: Env,
  fetcher: Fetcher = fetch,
): Promise<SystemHealthReport> {
  // Missing endpoints are reported as configuration state instead of failures
  // so the Discord command stays useful in local/dev environments.
  const websiteUrl = getOptionalUrlEnv(env, 'WEBSITE_URL');
  const wikiUrl = getOptionalUrlEnv(env, 'WIKI_URL');
  const [website, gateway, api, dashboard, wiki, comingSoonPages] =
    await Promise.all([
      checkConfiguredUrl('Website', websiteUrl, fetcher, '/'),
      checkGatewayHealth(env, fetcher),
      checkApiHealth(env),
      checkConfiguredUrl('Dashboard', websiteUrl, fetcher, '/dashboard'),
      checkConfiguredUrl('Wiki', wikiUrl, fetcher, '/'),
      checkComingSoonPages(websiteUrl, fetcher),
    ]);

  const allChecks = [website, gateway, api, dashboard, wiki];

  return {
    checkedAt: new Date().toISOString(),
    checks: {
      website,
      gateway,
      api,
      dashboard,
      wiki,
    },
    comingSoonPages,
    hasFailures: allChecks.some((check) => check.status === 'offline'),
    hasInvalidConfig: allChecks.some(
      (check) => check.status === 'invalid_config',
    ),
  };
}

async function checkGatewayHealth(
  env: Env,
  _fetcher: Fetcher,
): Promise<ServiceHealthCheck> {
  if (env.GATEWAY_SERVICE) {
    return checkEndpoint(
      'Gateway',
      getGatewayServiceUrl('/health'),
      (input, init) => env.GATEWAY_SERVICE!.fetch(input, init),
    );
  }

  return {
    name: 'Gateway',
    status: 'not_configured',
  };
}

async function checkConfiguredUrl(
  name: string,
  config: UrlEnvResult,
  fetcher: Fetcher,
  path?: string,
): Promise<ServiceHealthCheck> {
  // Convert config state into health state before doing any network work.
  if (config.status === 'missing') {
    return {
      name,
      status: 'not_configured',
    };
  }

  if (config.status === 'invalid') {
    return {
      error: config.reason,
      name,
      status: 'invalid_config',
    };
  }

  return checkEndpoint(
    name,
    path === undefined ? config.url : appendPath(config.url, path),
    fetcher,
  );
}

async function checkApiHealth(env: Env): Promise<ServiceHealthCheck> {
  if (env.API_WORKER) {
    return checkEndpoint('API', 'https://api.internal/health', (input, init) =>
      env.API_WORKER!.fetch(input, init),
    );
  }

  return {
    name: 'API',
    status: 'not_configured',
  };
}

async function checkEndpoint(
  name: string,
  url: string,
  fetcher: Fetcher,
): Promise<ServiceHealthCheck> {
  // HEAD keeps checks cheap for normal endpoints. Content checks use GET below.
  const startedAt = Date.now();
  // Each endpoint gets its own timeout so one stuck service does not make the
  // whole slash command miss Discord's interaction response window.
  const timeout = createTimeoutSignal(CHECK_TIMEOUT_MS);

  try {
    const response = await fetcher(url, {
      method: 'HEAD',
      signal: timeout.signal,
    });

    return {
      latencyMs: Date.now() - startedAt,
      name,
      status: response.status < 500 ? 'online' : 'offline',
      statusCode: response.status,
      url,
    };
  } catch (error) {
    return {
      error: getErrorMessage(error),
      name,
      status: 'offline',
      url,
    };
  } finally {
    timeout.clear();
  }
}

async function checkComingSoonPages(
  websiteUrl: UrlEnvResult,
  fetcher: Fetcher,
): Promise<string[]> {
  // This is informational only; coming-soon pages do not make health fail.
  if (websiteUrl.status !== 'configured') {
    return [];
  }

  const pageResults = await Promise.all(
    COMING_SOON_PAGES.map(async (page) => {
      const timeout = createTimeoutSignal(CHECK_TIMEOUT_MS);

      try {
        // These pages are intentionally checked with GET because the marker is
        // page content, not status code or headers.
        const response = await fetcher(appendPath(websiteUrl.url, page.path), {
          method: 'GET',
          signal: timeout.signal,
        });
        const text = await response.text();

        return /coming soon/i.test(text) ? page.name : undefined;
      } catch {
        return undefined;
      } finally {
        timeout.clear();
      }
    }),
  );

  return pageResults.filter((page): page is string => Boolean(page));
}

function appendPath(baseUrl: string, path: string): string {
  // URL handles duplicate/missing slashes more safely than string concatenation.
  return new URL(path, `${baseUrl}/`).toString();
}

function createTimeoutSignal(timeoutMs: number): {
  clear: () => void;
  signal: AbortSignal;
} {
  // Cloudflare Workers support AbortController, and clearing avoids stale timers
  // after fast responses.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return {
    clear: () => clearTimeout(timeoutId),
    signal: controller.signal,
  };
}
