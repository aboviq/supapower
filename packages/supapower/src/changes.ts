// oxlint-disable no-await-in-loop - The outgoing queue is a strictly ordered pipeline: batches go upstream oldest first,
// and every statement inside a batch has to land before the next one. Parallelizing any of it would reorder writes.
/**
 * The shape of the rows queued in `supapower.changes`.
 *
 * Kept in its own module so the public options in `./types.ts` can name them
 * without importing the sync loop, which would close an import cycle.
 */

import type { PGliteInterface } from '@electric-sql/pglite';

import type { SupapowerUploadError } from './errors.js';
import { once } from './utils.js';

export interface InsertChange {
  id: number;
  tx_id: string;
  table_name: string;
  operation: 'INSERT';
  new_data: Record<string, unknown>;
  old_data: null;
  changed_at: string;
}

export interface UpdateChange {
  id: number;
  tx_id: string;
  table_name: string;
  operation: 'UPDATE';
  new_data: Record<string, unknown>;
  old_data: Record<string, unknown>;
  changed_at: string;
}

export interface DeleteChange {
  id: number;
  tx_id: string;
  table_name: string;
  operation: 'DELETE';
  new_data: null;
  old_data: Record<string, unknown>;
  changed_at: string;
}

/** One queued local change, as written by the change trigger. */
export type ChangeRow = InsertChange | UpdateChange | DeleteChange;

/** Every queued change from a single local transaction. */
export interface SyncTransaction {
  /** The changes, in the order they were made. */
  batch: Readonly<ChangeRow[]>;
  /**
   * Removes the batch from the outgoing queue.
   *
   * Call it once the batch is upstream - or, from
   * {@link UnrecoverableUploadError}, to drop changes Supabase will never
   * accept. Only the changes that were yielded are removed.
   *
   * Idempotent, and safe to call concurrently: every caller after the first
   * awaits the same delete. A rejected delete is cached too, but the sync loop
   * throws the whole transaction away on error, so a retry always gets a fresh
   * one.
   */
  commit: () => Promise<void>;
}

/**
 * A batch Supabase rejected for a reason that retrying cannot fix - a type
 * mismatch, a constraint violation, or a row-level security denial.
 *
 * Handed to `onUnrecoverableError` so the application can decide what happens
 * to the rejected changes. See {@link SupapowerSyncOptions.onUnrecoverableError}.
 */
export interface UnrecoverableUploadError {
  /** The error Supabase returned, wrapped so `error.cause` is the PostgREST one. */
  readonly error: SupapowerUploadError;
  /** Every change in the local transaction that failed, in order. */
  readonly batch: Readonly<ChangeRow[]>;
  /**
   * The change that was rejected.
   *
   * The changes before it in `batch` are already upstream; the ones after it
   * were never attempted.
   */
  readonly change: ChangeRow;
  /**
   * Drops the whole batch from the outgoing queue, the rejected change
   * included.
   *
   * This is {@link SyncTransaction.commit}. Returning without calling it
   * leaves the batch queued, and the sync retries it after a backoff.
   */
  readonly commit: () => Promise<void>;
}

/**
 * Yields the queued changes one local transaction at a time, oldest first.
 *
 * A batch is every row sharing the `tx_id` of the lowest `id` still queued, so
 * a local transaction reaches Supabase whole or not at all. The generator ends
 * when the queue is empty.
 *
 * Only changes to `tables` are considered. Changes to any other table stay
 * queued and untouched, which is what keeps a signed out client from pushing
 * the previous session's work with an anonymous token.
 *
 * Callers must hold leadership for as long as they iterate - see
 * `./leadership.ts` for why that cannot be a lock inside Postgres.
 */
export async function* getNextSyncTransaction(
  pg: PGliteInterface,
  tables: string[],
  signal: AbortSignal,
): AsyncGenerator<SyncTransaction, undefined, void> {
  while (!signal.aborted) {
    // Get the oldest unsynced change's transaction ID
    const oldest = await pg.sql<{ tx_id: string }>`
      SELECT tx_id FROM supapower.changes
      WHERE table_name = ANY(${tables}::text[])
      ORDER BY id ASC LIMIT 1
    `;

    if (signal.aborted) {
      return;
    }

    const [row] = oldest.rows;

    if (!row) {
      return; // no more unsynced changes - the generator is done
    }

    // Fetch all rows with the same tx_id, in insertion order
    const batch = await pg.sql<ChangeRow>`
      SELECT * FROM supapower.changes
      WHERE tx_id = ${row.tx_id}
        AND table_name = ANY(${tables}::text[])
      ORDER BY id ASC
    `;

    if (signal.aborted) {
      return;
    }

    // `once` caches the promise rather than flipping a flag after the await,
    // so two overlapping calls share one DELETE instead of both slipping past
    // the guard. That matters because `commit` is handed to application code
    // through `onUnrecoverableError`, which may well call it more than once.
    const commit = once(async () => {
      // A tx_id is closed by the time it reaches the queue, so no row can join
      // this batch after it was read. The table filter repeats here so that a
      // transaction touching both reachable and unreachable tables only loses
      // the half that was actually pushed.
      await pg.sql`
        DELETE FROM supapower.changes
        WHERE tx_id = ${row.tx_id}
          AND table_name = ANY(${tables}::text[])
      `;
    });

    yield { batch: batch.rows, commit };
  }
}
