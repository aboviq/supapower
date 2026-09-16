import type { PostgrestError } from '@supabase/supabase-js';

/**
 * Machine readable reason for a {@link SupapowerError}.
 *
 * Codes are part of the public API: they are safe to switch on and are only
 * removed in a major release.
 */
export type SupapowerErrorCode =
  /** A remote change could not be written into the local database. */
  | 'apply_failed'
  /** A realtime channel could not be reached or stay joined. */
  | 'connection_failed'
  /** Supabase accepted a `DELETE` that matched no row. */
  | 'delete_ignored'
  /** Reading from Supabase failed. */
  | 'download_failed'
  | 'not_initialized'
  /** A queued change names a table that is not configured for syncing. */
  | 'schema_mismatch'
  /** Anything that went wrong on the way out, local queue included. */
  | 'upload_failed';

export interface SupapowerErrorOptions extends ErrorOptions {
  /** Machine readable reason for the failure. */
  readonly code: SupapowerErrorCode;
}

/**
 * Base class for every error thrown by Supapower.
 *
 * Wrap the underlying failure in `cause` so the original stack survives:
 *
 * ```ts
 * throw new SupapowerError('Could not reach Supabase', {
 *   code: 'connection_failed',
 *   cause: error,
 * });
 * ```
 */
export class SupapowerError extends Error {
  override readonly name: string = 'SupapowerError';

  readonly code: SupapowerErrorCode;

  constructor(message: string, options: SupapowerErrorOptions) {
    super(message, options);
    this.code = options.code;
  }
}

export interface SupapowerUploadErrorOptions {
  cause: PostgrestError;
}

export class SupapowerUploadError extends SupapowerError {
  override readonly name: string = 'SupapowerUploadError';
  override readonly cause: PostgrestError;

  constructor(message: string, options: SupapowerUploadErrorOptions) {
    super(message, { code: 'upload_failed', cause: options.cause });
    this.cause = options.cause;
  }
}

/** Narrows an unknown value to a {@link SupapowerError}. */
export function isSupapowerError(value: unknown): value is SupapowerError {
  return value instanceof SupapowerError;
}

export function isSupapowerUploadError(value: unknown): value is SupapowerUploadError {
  return value instanceof SupapowerError && value.code === 'upload_failed';
}

/**
 * Wraps anything that is not already a {@link SupapowerError}.
 *
 * Everything Supapower hands to a callback goes through here, so a handler can
 * always read `code` and reach the original failure through `cause` rather than
 * having to narrow an `unknown` first.
 *
 * @param value The thrown value to wrap.
 * @param message Describes what Supapower was doing when it failed.
 * @param code The code to give the wrapper.
 */
export function asSupapowerError(
  value: unknown,
  message: string,
  code: SupapowerErrorCode,
): SupapowerError {
  return isSupapowerError(value) ? value : new SupapowerError(message, { code, cause: value });
}

/**
 * Postgres response codes that retrying cannot fix.
 *
 * A batch rejected with one of these is rejected the same way every time, so
 * leaving it queued would block every later change behind it forever.
 */
const FATAL_RESPONSE_CODES = [
  // Class 22 - Data Exception, e.g. a data type mismatch.
  /^22...$/,
  // Class 23 - Integrity Constraint Violation, e.g. NOT NULL, FOREIGN KEY and
  // UNIQUE violations.
  /^23...$/,
  // INSUFFICIENT PRIVILEGE - typically a row-level security violation.
  /^42501$/,
];

/**
 * Whether Supabase rejected a change for a reason that retrying cannot fix.
 *
 * These usually mean a bug in the application rather than a transient failure:
 * the data does not fit the remote schema, or the user is not allowed to write
 * it. The code is read off the {@link SupapowerUploadError}'s `cause` - a
 * Postgres SQLSTATE - and not off {@link SupapowerError.code}, which is
 * Supapower's own taxonomy.
 *
 * Exported so a custom `onUnrecoverableError` can classify further.
 */
export function isUnrecoverableUploadError(value: unknown): value is SupapowerUploadError {
  if (!isSupapowerUploadError(value)) {
    return false;
  }

  const { code } = value.cause;

  return FATAL_RESPONSE_CODES.some((pattern) => pattern.test(code));
}
