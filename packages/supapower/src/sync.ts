// oxlint-disable no-await-in-loop -- The outgoing queue is a strictly ordered
// pipeline: batches go upstream oldest first, and every statement inside a batch
// has to land before the next one. Parallelizing any of it would reorder writes.

import type { PGliteInterface, Transaction } from '@electric-sql/pglite';
import {
  REALTIME_SUBSCRIBE_STATES,
  type RealtimePostgresChangesPayload,
  type SupabaseClient,
} from '@supabase/supabase-js';

import {
  getNextSyncTransaction,
  type ChangeRow,
  type UnrecoverableUploadError,
} from './changes.js';
import { CHANGES_CHANNEL } from './constants.js';
import { isUnrecoverableUploadError, SupapowerError, SupapowerUploadError } from './errors.js';
import { setSyncedIncomingAt } from './metadata.js';
import type { SupapowerTableConfig } from './types.js';
import { escapeIdentifier, executeInTransaction } from './utils.js';

/** Safety net in case a notification is missed while leadership changes hands. */
const IDLE_POLL_MS = 30_000;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/** A table config with the defaults filled in. */
export interface ResolvedTableConfig {
  table: string;
  primaryKey: string;
  access: 'anon' | 'authenticated';
}

/** Fills in the defaults for a table entry and keys them by table name. */
export function resolveTables(
  tables: Array<SupapowerTableConfig | string>,
): Map<string, ResolvedTableConfig> {
  return new Map(
    tables.map((entry) => {
      const config = typeof entry === 'string' ? { table: entry } : entry;

      return [
        config.table,
        {
          table: config.table,
          primaryKey: config.primaryKey ?? 'id',
          access: config.access ?? 'authenticated',
        },
      ];
    }),
  );
}

function tableFor(
  change: ChangeRow,
  tables: Map<string, ResolvedTableConfig>,
): ResolvedTableConfig {
  const config = tables.get(change.table_name);

  if (!config) {
    throw new SupapowerError(
      `Local changes are queued for "${change.table_name}", which is not configured for syncing`,
      { code: 'schema_mismatch' },
    );
  }

  return config;
}

/**
 * Pushes one queued change upstream.
 *
 * The statements are idempotent on purpose: a crash between the upstream write
 * and {@link SyncTransaction.commit} leaves the batch queued, so the next
 * leader sends it again.
 */
async function pushChange(
  supabase: SupabaseClient,
  tables: Map<string, ResolvedTableConfig>,
  change: ChangeRow,
): Promise<void> {
  const { table, primaryKey } = tableFor(change, tables);

  const { error } =
    change.operation === 'DELETE'
      ? await supabase.from(table).delete().eq(primaryKey, change.old_data[primaryKey])
      : await supabase.from(table).upsert(change.new_data, { onConflict: primaryKey });

  if (error) {
    throw new SupapowerUploadError(
      `Could not push a ${change.operation} on "${table}" to Supabase: ${error.message}`,
      { cause: error },
    );
  }
}

/** Resolves on the next queued change, after `timeoutMs`, or once aborted. */
async function waitForChanges(
  pg: PGliteInterface,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted) {
    return;
  }

  let wake: (() => void) | undefined;

  const woken = new Promise<void>((resolve) => {
    wake = resolve;
  });

  const timer = setTimeout(() => wake?.(), timeoutMs);

  signal.addEventListener('abort', () => wake?.(), { once: true });

  const unlisten = await pg.listen(CHANGES_CHANNEL, () => wake?.());

  try {
    await woken;
  } finally {
    clearTimeout(timer);
    await unlisten();
  }
}

/** Waits out a backoff, returning early if the signal aborts. */
async function backOff(signal: AbortSignal, attempt: number): Promise<void> {
  const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delay);

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * What happens to a batch Supabase will never accept.
 *
 * Discarding it is the only way to keep the queue moving, since every later
 * change is stuck behind it. Applications that cannot afford to lose the data
 * should replace this with a handler that stores the batch somewhere first.
 */
export const discardUnrecoverable = async ({ commit }: UnrecoverableUploadError): Promise<void> => {
  await commit();
};

export interface OutgoingSyncOptions {
  pg: PGliteInterface;
  supabase: SupabaseClient;
  tables: Map<string, ResolvedTableConfig>;
  /** Aborted when leadership is lost or the sync is unsubscribed. */
  signal: AbortSignal;
  /** Handles batches Supabase rejects for good. Defaults to discarding them. */
  onUnrecoverableError?: (context: UnrecoverableUploadError) => void | Promise<void>;
  /** Called when a batch could not be pushed, before the retry is scheduled. */
  onError?: (error: unknown) => void;
}

/**
 * Drains the outgoing queue for as long as the signal is live.
 *
 * Runs only while this process holds leadership - the caller passes a signal
 * that is aborted the moment it loses it, mid-batch included. A batch that was
 * sent upstream but not yet committed is re-sent by the next leader, which is
 * why {@link pushChange} only issues idempotent statements.
 *
 * Failures are sorted into two kinds. Anything transient - offline, a 5xx, a
 * dropped connection - leaves the batch queued and is retried with an
 * exponential backoff. Anything Supabase will reject the same way every time
 * goes to `onUnrecoverableError`, because retrying it would wedge the queue.
 */
export async function runOutgoingSync({
  pg,
  supabase,
  tables,
  signal,
  onUnrecoverableError = discardUnrecoverable,
  onError,
}: OutgoingSyncOptions): Promise<void> {
  let attempt = 0;

  while (!signal.aborted) {
    try {
      for await (const { batch, commit } of getNextSyncTransaction(pg, signal)) {
        let rejected: ChangeRow | undefined;

        try {
          for (const change of batch) {
            if (signal.aborted) {
              return; // leadership is gone; leave the batch for the next leader
            }

            rejected = change;

            await pushChange(supabase, tables, change);
          }

          if (signal.aborted) {
            return;
          }

          await commit();
        } catch (error) {
          if (signal.aborted) {
            return;
          }

          if (!rejected || !isUnrecoverableUploadError(error)) {
            throw error; // transient - back off and try the same batch again
          }

          let discarded = false;

          await onUnrecoverableError({
            error,
            batch,
            change: rejected,
            commit: async () => {
              discarded = true;
              await commit();
            },
          });

          if (!discarded) {
            // The handler kept the batch, so the queue has not moved. Rethrow
            // to back off instead of spinning on a change that cannot succeed.
            throw error;
          }
        }
      }

      attempt = 0;

      await waitForChanges(pg, signal, IDLE_POLL_MS);
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      onError?.(error);

      await backOff(signal, attempt);

      attempt += 1;
    }
  }
}

/**
 * Handles an incoming change from Supabase by applying it to the local database.
 * Supports INSERT, UPDATE, and DELETE events.
 *
 * @param pg The PGlite interface or transaction to execute the change within.
 * @param payload The payload describing the incoming change from Supabase.
 * @param primaryKey The primary key column of the table being changed.
 */
async function handleIncomingChange(
  pg: PGliteInterface | Transaction,
  payload: RealtimePostgresChangesPayload<Record<string, unknown>>,
  primaryKey: string,
) {
  const columns: string[] = [];
  const parameters: unknown[] = [];

  for (const [column, value] of Object.entries(payload.new)) {
    columns.push(column);
    parameters.push(value);
  }

  let query: string;

  if (payload.eventType === 'INSERT') {
    query = `
      INSERT INTO ${escapeIdentifier(payload.schema, payload.table)} (
        ${columns.map((column) => escapeIdentifier(column)).join(',\n        ')}
      )
      VALUES (
        ${columns.map((_, index) => `$${index + 1}`).join(',\n        ')}
      )
      ON CONFLICT (${escapeIdentifier(primaryKey)}) DO UPDATE SET
        ${columns.map((column) => `${escapeIdentifier(column)} = EXCLUDED.${escapeIdentifier(column)}`).join(',\n        ')}
    `;
  } else if (payload.eventType === 'UPDATE') {
    parameters.push(payload.old[primaryKey]);
    query = `
      UPDATE
        ${escapeIdentifier(payload.schema, payload.table)}
      SET
        ${columns.map((column, index) => `${escapeIdentifier(column)} = $${index + 1}`).join(',\n        ')}
      WHERE
        ${escapeIdentifier(primaryKey)} = $${parameters.length}
    `;
  } else if (payload.eventType === 'DELETE') {
    parameters.length = 0;
    parameters.push(payload.old[primaryKey]);
    query = `DELETE FROM ${escapeIdentifier(payload.schema, payload.table)} WHERE ${escapeIdentifier(primaryKey)} = $${parameters.length}`;
  }

  await executeInTransaction(pg, async (tx) => {
    await tx.sql`SELECT set_config('supapower.applying', 'true', true)`;

    await tx.query(query, parameters);

    await setSyncedIncomingAt(tx, payload.table, new Date(payload.commit_timestamp));
  });
}

export interface IncomingSyncOptions {
  pg: PGliteInterface;
  supabase: SupabaseClient;
  /**
   * The tables to subscribe to.
   *
   * Already filtered for the current user - deciding which tables are
   * reachable is the caller's job, see `access` in `SupapowerTableConfig`.
   */
  tables: Map<string, ResolvedTableConfig>;
  /**
   * Aborted when leadership is lost, when the signed in user changes, or when
   * the sync is unsubscribed.
   */
  signal: AbortSignal;
  /** Overrides the generated channel name. */
  channel?: string;
  /** Called when a change could not be applied, or the channel reports trouble. */
  onError?: (error: unknown) => void;
}

/**
 * Applies remote changes locally for as long as the signal is live.
 *
 * Subscribes one realtime channel to `postgres_changes` on every table it is
 * given and writes each change straight into the local database, with
 * `supapower.applying` set so the change triggers do not queue it right back up
 * as an outgoing change.
 *
 * Runs only on the tab that holds leadership. Every tab shares one database, so
 * a subscription per tab would apply each change as many times as there are
 * tabs open.
 *
 * This function does not look at authentication. It subscribes to exactly the
 * tables it is handed and keeps that subscription until the signal aborts -
 * which is what makes it cheap for the caller to restart it with a different
 * set when the user signs in or out.
 */
export async function runIncomingSync({
  pg,
  supabase,
  tables,
  signal,
  channel = `supapower:incoming:${crypto.randomUUID()}`,
  onError,
}: IncomingSyncOptions): Promise<void> {
  if (signal.aborted || tables.size === 0) {
    return; // nothing this user is allowed to see
  }

  // Realtime hands us its callbacks synchronously while applying a change is
  // async, so the work is chained: two updates to the same row have to land in
  // the order they were broadcast.
  let applying: Promise<void> = Promise.resolve();

  const apply = (payload: RealtimePostgresChangesPayload<Record<string, unknown>>, key: string) => {
    const previous = applying;

    applying = (async () => {
      await previous;

      if (signal.aborted) {
        return;
      }

      try {
        await handleIncomingChange(pg, payload, key);
      } catch (error: unknown) {
        // Caught per change so one bad row cannot break the chain for the rest.
        onError?.(error);
      }
    })();
  };

  let subscription = supabase.channel(channel);

  for (const { table, primaryKey } of tables.values()) {
    subscription = subscription.on(
      'postgres_changes',
      { event: '*', schema: 'public', table },
      (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) =>
        apply(payload, primaryKey),
    );
  }

  const closed = new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });

    subscription.subscribe((status, error) => {
      if (
        status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED
        || status === REALTIME_SUBSCRIBE_STATES.CLOSED
      ) {
        return; // CLOSED is what unsubscribing looks like from in here
      }

      // CHANNEL_ERROR and TIMED_OUT are reported but not acted on: realtime-js
      // rejoins on its own, and tearing the channel down here would fight it.
      onError?.(
        error
          ?? new SupapowerError(`Realtime channel "${channel}" reported ${status}`, {
            code: 'connection_failed',
          }),
      );
    });
  });

  try {
    await closed;
  } finally {
    await Promise.all([supabase.removeChannel(subscription), applying]);
  }
}
