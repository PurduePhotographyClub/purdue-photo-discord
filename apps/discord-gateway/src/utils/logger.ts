/**
 * Logger used by the VPS Gateway.
 *
 * systemd collects stdout/stderr, so this keeps logging simple and scrubs common
 * secret-looking fields before metadata reaches the journal.
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
  'secret',
  'signature',
  'token',
];

const REDACTED = '[redacted]';

export function createLogger(scope: string): Logger {
  // Bind the scope once so call sites can stay focused on the event they are
  // logging.
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
  // systemd captures each console call as one journal line. One structured
  // object keeps scope, message, and metadata together for filtering.
  console[level]({
    level,
    message,
    scope,
    timestamp: new Date().toISOString(),
    ...(meta === undefined ? {} : { meta: sanitizeLogValue(meta) }),
  });
}

function sanitizeLogValue(value: unknown): unknown {
  // Walk metadata recursively so nested secrets are scrubbed too.
  if (value instanceof Error) {
    // Error stacks can include environment-specific paths; the message/name are
    // enough for operational logs here.
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
  // Redaction is key-based, which keeps it predictable without trying to inspect
  // arbitrary values.
  const normalized = key.toLowerCase();

  if (normalized.startsWith('has') || normalized.endsWith('length')) {
    return false;
  }

  // Match substrings so names like internalApiSecret and discordToken are caught
  // without every secret-bearing key needing to be listed exactly.
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
  // Arrays are handled separately above, so this branch is for plain-ish objects.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
