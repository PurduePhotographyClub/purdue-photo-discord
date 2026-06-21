/**
 * Logger used by the Cloudflare Worker.
 *
 * It keeps the console output structured enough for logs while scrubbing common
 * secret fields from metadata.
 */
export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

type LogLevel = keyof Logger;

const REDACTED_KEYS = [
  'authorization',
  'cookie',
  'key',
  'nonce',
  'password',
  'public_key',
  'secret',
  'signature',
  'token',
];

const REDACTED = '[redacted]';

export function createLogger(scope: string): Logger {
  // Scope prefixes make mixed Worker logs easier to scan.
  return {
    debug: (message, meta) => writeLog('debug', scope, message, meta),
    info: (message, meta) => writeLog('info', scope, message, meta),
    warn: (message, meta) => writeLog('warn', scope, message, meta),
    error: (message, meta) => writeLog('error', scope, message, meta),
  };
}

function writeLog(
  level: LogLevel,
  scope: string,
  message: string,
  meta?: unknown,
): void {
  // Emit one structured record per log event. Cloudflare keeps console output as
  // log lines, so a single sanitized object is easier to query than split args.
  console[level]({
    level,
    message,
    scope,
    timestamp: new Date().toISOString(),
    ...(meta === undefined ? {} : { meta: sanitizeLogValue(meta) }),
  });
}

function sanitizeLogValue(value: unknown): unknown {
  // Error objects do not JSON-stringify well and can include noisy stacks.
  if (value instanceof Error) {
    return {
      cause:
        value.cause instanceof Error
          ? sanitizeLogValue(value.cause)
          : sanitizeLogValue(value.cause),
      name: value.name,
      message: redactSensitiveString(value.message),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }

  if (!isRecord(value)) {
    return typeof value === 'string' ? redactSensitiveString(value) : value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      shouldRedact(key) ? '[redacted]' : sanitizeLogValue(entryValue),
    ]),
  );
}

function shouldRedact(key: string): boolean {
  // Match substrings so names like internalApiSecret are covered.
  const normalized = key.toLowerCase();

  if (normalized.startsWith('has') || normalized.endsWith('length')) {
    return false;
  }

  return REDACTED_KEYS.some((redactedKey) => normalized.includes(redactedKey));
}

function redactSensitiveString(value: string): string {
  return value
    .replace(
      /(authorization|cookie|nonce|signature|token|secret|password|api[-_ ]?key)\s*[:=]\s*[^,&\s}]+/gi,
      `$1=${REDACTED}`,
    )
    .replace(/bearer\s+[a-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`)
    .replace(
      /([?&](?:code|key|nonce|signature|token|secret)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays are handled above; this branch is for keyed metadata objects.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
