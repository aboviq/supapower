// oxlint-disable no-await-in-loop -- The outgoing queue is a strictly ordered
// pipeline: batches go upstream oldest first, and every statement inside a batch
// has to land before the next one. Parallelizing any of it would reorder writes.

import type { PGliteInterface, Transaction } from '@electric-sql/pglite';
import {
  REALTIME_SUBSCRIBE_STATES,
  type RealtimePostgresChangesPayload,
  type RealtimePostgresInsertPayload,
  type SupabaseClient,
} from '@supabase/supabase-js';

import {
  getNextSyncTransaction,
  type ChangeRow,
  type UnrecoverableUploadError,
} from './changes.js';
import { CHANGES_CHANNEL } from './constants.js';
import {
  asSupapowerError,
  isUnrecoverableUploadError,
  SupapowerError,
  SupapowerUploadError,
} from './errors.js';
import {
  clearSyncedCursorAt,
  clearSyncedIncomingAt,
  getSyncedCursorAt,
  getSyncedUser,
  setSyncedCursorAt,
  setSyncedIncomingAt,
  setSyncedUser,
} from './metadata.js';
import type { SupapowerTableConfig } from './types.js';
import { escapeIdentifier, executeInTransaction } from './utils.js';

/** Safety net in case a notification is missed while leadership changes hands. */
const IDLE_POLL_MS = 30_000;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/**
 * How far back an incremental download reaches beyond the last cursor value it
 * saw.
 *
 * A write stamps its cursor column with the transaction's start time but only
 * becomes visible when it commits, so a slow transaction can land a row
 * *behind* a watermark that has already moved past it. Reaching back covers
 * transactions up to this long; anything slower is missed until the table is
 * downloaded whole again.
 */
const CURSOR_MARGIN_MS = 60_000;

/** A table config with the defaults filled in. */
export interface ResolvedTableConfig {
  table: string;
  primaryKey: string;
  access: 'anon' | 'authenticated';
  /** Timestamp column an incremental download filters on, when there is one. */
  cursor?: string;
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
          ...(config.cursor ? { cursor: config.cursor } : {}),
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
): Promise<boolean> {
  const { table, primaryKey } = tableFor(change, tables);

  // A DELETE is asked to count what it removed. Row-level security filters a
  // forbidden row out of the `USING` clause rather than raising, so without the
  // count a denied delete is indistinguishable from a successful one.
  const { error, count } =
    change.operation === 'DELETE'
      ? await supabase
          .from(table)
          .delete({ count: 'exact' })
          .eq(primaryKey, change.old_data[primaryKey])
      : await supabase.from(table).upsert(change.new_data, { onConflict: primaryKey });

  if (error) {
    throw new SupapowerUploadError(
      `Could not push a ${change.operation} on "${table}" to Supabase: ${error.message}`,
      { cause: error },
    );
  }

  // `null` means the server did not report a count; only a definite zero is
  // worth telling anybody about.
  return change.operation !== 'DELETE' || count !== 0;
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
  onError?: (error: SupapowerError) => void;
}

/**
 * Drains the outgoing queue for as long as the signal is live.
 *
 * Runs only while this process holds leadership - the caller passes a signal
 * that is aborted the moment it loses it, mid-batch included. A batch that was
 * sent upstream but not yet committed is re-sent by the next leader, which is
 * why {@link pushChange} only issues idempotent statements.
 *
 * Only changes to the tables it is given are drained; anything else stays
 * queued. That is what a signed out client relies on - its previous session's
 * changes wait rather than being pushed with an anonymous token and discarded
 * as a row-level security denial.
 *
 * A DELETE that matches no row is reported through `onError` rather than
 * thrown. It cannot be told apart from a batch re-sent after a crash, so the
 * queue keeps moving and the application decides whether it was a divergence.
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
  const reachable = [...tables.keys()];

  let attempt = 0;

  while (!signal.aborted) {
    try {
      for await (const { batch, commit } of getNextSyncTransaction(pg, reachable, signal)) {
        let rejected: ChangeRow | undefined;

        try {
          for (const change of batch) {
            if (signal.aborted) {
              return; // leadership is gone; leave the batch for the next leader
            }

            rejected = change;

            const applied = await pushChange(supabase, tables, change);

            if (!applied) {
              // Not thrown: a batch re-sent after a crash legitimately deletes
              // nothing the second time, and failing here would wedge the queue
              // on a change that can never succeed again.
              onError?.(
                new SupapowerError(
                  `Supabase ignored a DELETE on "${change.table_name}": no row matched. It may already be gone, or row-level security may be hiding it from this user.`,
                  { code: 'delete_ignored' },
                ),
              );
            }
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

      onError?.(asSupapowerError(error, 'The outgoing sync failed', 'upload_failed'));

      await backOff(signal, attempt);

      attempt += 1;
    }
  }
}

/**
 * Handles an incoming change from Supabase by applying it to the local database.
 * Supports INSERT, UPDATE, and DELETE events.
 *
 * `supapower.applying` is set for the transaction so the change triggers skip
 * it: an incoming change must not be queued straight back up as an outgoing
 * one. The watermark moves in the same transaction as the row itself.
 *
 * @param pg The PGlite interface or transaction to execute the change within.
 * @param payload The payload describing the incoming change from Supabase.
 * @param primaryKey The primary key column of the table being changed.
 */
export async function handleIncomingChange(
  pg: PGliteInterface | Transaction,
  payload: RealtimePostgresChangesPayload<Record<string, unknown>>,
  primaryKey: string,
): Promise<void> {
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

/**
 * Drops every row the previous user could see, if the user has changed.
 *
 * Tables left on the default `authenticated` access hold data that belongs to
 * whoever was signed in, so signing in or out has to clear them. Tables marked
 * `anon` are readable by everybody and are left alone.
 *
 * Queued outgoing changes for those tables go with them: they were made by the
 * previous user and cannot be pushed as the next one. Unsynced local work is
 * lost, which is the price of the `authenticated` setting.
 *
 * @param user The user the local data should belong to, `null` for nobody.
 * @returns Whether anything was dropped.
 */
export async function reconcileUser(
  pg: PGliteInterface,
  tables: Map<string, ResolvedTableConfig>,
  user: string | null,
): Promise<boolean> {
  const previous = await getSyncedUser(pg);

  if (previous === user) {
    return false;
  }

  const owned = [...tables.values()].filter((config) => config.access === 'authenticated');

  await pg.transaction(async (tx) => {
    for (const { table } of owned) {
      // TRUNCATE only fires TRUNCATE triggers, so this does not queue itself up
      // as a pile of outgoing deletes.
      await tx.query(`TRUNCATE TABLE ${escapeIdentifier('public', table)}`);

      await tx.sql`DELETE FROM supapower.changes WHERE table_name = ${table}`;
    }

    const names = owned.map(({ table }) => table);

    await clearSyncedIncomingAt(tx, names);
    await clearSyncedCursorAt(tx, names);

    await setSyncedUser(tx, user);
  });

  return owned.length > 0;
}

/** Dresses a downloaded row up as the INSERT event it would have been. */
function asInsertEvent(
  table: string,
  row: Record<string, unknown>,
  snapshotAt: string,
): RealtimePostgresInsertPayload<Record<string, unknown>> {
  return {
    eventType: 'INSERT',
    schema: 'public',
    table,
    commit_timestamp: snapshotAt,
    new: row,
    old: {},
    errors: [],
  };
}

async function downloadTable(
  pg: PGliteInterface,
  supabase: SupabaseClient,
  { table, primaryKey, cursor }: ResolvedTableConfig,
  signal: AbortSignal,
): Promise<void> {
  // Taken before the request so a change made while it is in flight is dated
  // after the snapshot rather than swallowed by it.
  const snapshotAt = new Date().toISOString();

  const watermark = cursor ? await getSyncedCursorAt(pg, table) : null;
  const since = watermark === null ? Number.NaN : Date.parse(watermark);

  // Where an incremental download starts: {@link CURSOR_MARGIN_MS} further back
  // than the last value seen. A watermark that is not a timestamp gives up and
  // pulls the whole table rather than guessing at how to step back from it.
  const from = Number.isNaN(since) ? null : new Date(since - CURSOR_MARGIN_MS).toISOString();

  const select = supabase.from(table).select();

  const { data, error } = await (cursor && from ? select.gte(cursor, from) : select);

  if (error) {
    throw new SupapowerError(`Could not download "${table}" from Supabase: ${error.message}`, {
      code: 'download_failed',
      cause: error,
    });
  }

  if (signal.aborted || data.length === 0) {
    return;
  }

  // One transaction for the whole table: a half applied snapshot is worse than
  // no snapshot, and it keeps the per row round trips off the shared worker.
  await pg.transaction(async (tx) => {
    let highest: string | null = null;

    // Seeded with the value already stored, so the same comparison that finds
    // the furthest along row also keeps the watermark moving only forwards: a
    // hard deleted row can drag the highest value in the table backwards, and
    // reaching further back next time is pointless.
    let highestAt = Number.isNaN(since) ? Number.NEGATIVE_INFINITY : since;

    for (const row of data) {
      await handleIncomingChange(tx, asInsertEvent(table, row, snapshotAt), primaryKey);

      if (cursor === undefined) {
        continue;
      }

      const value = row[cursor];

      if (typeof value !== 'string') {
        continue;
      }

      const at = Date.parse(value);

      if (!Number.isNaN(at) && at > highestAt) {
        highest = value;
        highestAt = at;
      }
    }

    if (highest !== null) {
      await setSyncedCursorAt(tx, table, highest);
    }
  });
}

export interface InitialSyncOptions {
  pg: PGliteInterface;
  supabase: SupabaseClient;
  /** The tables to download, in the order they should be downloaded. */
  tables: Map<string, ResolvedTableConfig>;
  signal: AbortSignal;
}

/**
 * Downloads every row of every table and writes it into the local database.
 *
 * A table configured with a `cursor` column is only asked for rows at or after
 * the last value downloaded, less a margin; one without is pulled whole on
 * every start. Either way the rows go through the same path as a realtime
 * INSERT, so the upsert on the primary key makes re-running it harmless.
 *
 * It does not delete anything. A row that was hard deleted remotely while this
 * client was away still needs {@link reconcileUser} or a remote DELETE event to
 * disappear locally, which is why soft deletes are the recommendation.
 */
export async function runInitialSync({
  pg,
  supabase,
  tables,
  signal,
}: InitialSyncOptions): Promise<void> {
  for (const config of tables.values()) {
    if (signal.aborted) {
      return;
    }

    await downloadTable(pg, supabase, config, signal);
  }
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
  onError?: (error: SupapowerError) => void;
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

  const enqueue = (task: () => Promise<void>) => {
    const previous = applying;

    applying = (async () => {
      await previous;

      if (signal.aborted) {
        return;
      }

      try {
        await task();
      } catch (error: unknown) {
        // Caught per task so one bad row cannot break the chain for the rest.
        onError?.(asSupapowerError(error, 'Could not apply a remote change', 'apply_failed'));
      }
    })();
  };

  const apply = (payload: RealtimePostgresChangesPayload<Record<string, unknown>>, key: string) =>
    enqueue(() => handleIncomingChange(pg, payload, key));

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
        asSupapowerError(
          error,
          `Realtime channel "${channel}" reported ${status}`,
          'connection_failed',
        ),
      );
    });
  });

  // Subscribe first, download second: a change made while the snapshot is in
  // flight arrives on the open channel and queues up behind it, rather than
  // falling in the gap between the two.
  enqueue(() => runInitialSync({ pg, supabase, tables, signal }));

  try {
    await closed;
  } finally {
    await Promise.all([supabase.removeChannel(subscription), applying]);
  }
}
