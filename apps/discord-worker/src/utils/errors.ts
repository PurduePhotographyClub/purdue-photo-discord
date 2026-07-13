/**
 * App-level errors used by Worker routes and services.
 *
 * expose=false is the default so unexpected failures do not leak details to HTTP
 * callers or Discord users.
 */
export interface AppErrorOptions {
  status?: number;
  code?: string;
  expose?: boolean;
  details?: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    // Restore the subclass prototype because built-in Error is special in JS.
    super(message);
    this.name = new.target.name;
    this.status = options.status ?? 500;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.expose = options.expose ?? false;

    if (options.details !== undefined) {
      this.details = options.details;
    }

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    // 400s are safe to expose because they describe caller input problems.
    super(message, {
      code: 'BAD_REQUEST',
      details,
      expose: true,
      status: 400,
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    // Auth failures should be explicit enough for clients, without sharing which
    // secret or signature check failed.
    super(message, {
      code: 'UNAUTHORIZED',
      expose: true,
      status: 401,
    });
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    // Config errors are exposed so deploy checks and slash commands can point to
    // the missing setting instead of saying "internal error."
    super(message, {
      code: 'CONFIG_ERROR',
      expose: true,
      status: 500,
    });
  }
}

export class DiscordApiError extends AppError {
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    status: number,
    details?: unknown,
    retryAfterMs?: number,
  ) {
    // Discord's 4xx responses are usually actionable caller problems. 5xx stays
    // opaque to users because it is either Discord downtime or an unexpected bug.
    super(message, {
      code: 'DISCORD_API_ERROR',
      details,
      expose: status < 500,
      status,
    });
    this.retryAfterMs = retryAfterMs;
  }
}

export function isAppError(error: unknown): error is AppError {
  // Route helpers use this to decide whether an error has an intentional status.
  return error instanceof AppError;
}

export function getErrorMessage(error: unknown): string {
  // Command replies need a plain string even when a thrown value is not Error.
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}
