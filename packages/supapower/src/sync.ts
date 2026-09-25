// oxlint-disable no-await-in-loop -- The outgoing queue is a strictly ordered
// pipeline: batches go upstream oldest first, and every statement inside a batch
// has to land before the next one. Parallelizing any of it would reorder writes.

import type { PGliteInterface, Transaction } from '@electric-sql/pglite';
import {
  type PostgrestError,
  REALTIME_SUBSCRIBE_STATES,
  type RealtimePostgresChangesPayload,
  type RealtimePostgresInsertPayload,
  type SupabaseClient,
} from '@supabase/supabase-js';

import {
  getNextSyncTransaction,
  type ChangeRow,
  type UnrecoverableUploadError,
  type UpdateChange,
} from './changes.js';
import { CHANGES_CHANNEL, REFRESH_CHANNEL } from './constants.js';
import {
  asSupapowerError,
  isUnrecoverableUploadError,
  SupapowerError,
  SupapowerUploadError,
} from './errors.js';
import {
  createSupapowerEvents,
  SupapowerErrorEvent,
  SupapowerTableEvent,
  type SupapowerEventTarget,
} from './events.js';
import { applyFilter, type ResolvedFilters } from './filter.js';
import {
  clearTableSyncState,
  getRefreshRequest,
  getSyncedUser,
  getTableSyncState,
  setSyncedUser,
  setTableSyncState,
  type TableSyncState,
} from './metadata.js';
import type {
  ResolvedTableConfig,
  SupapowerScopedTable,
  SupapowerSyncedTable,
  SupapowerTableConfig,
} from './types.js';
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

/** How long a completed download of a table counts as fresh. */
const DOWNLOAD_THROTTLE_MS = 60_000;

/** Supabase's default PostgREST `max-rows` cap per request. */
const DOWNLOAD_PAGE_SIZE = 1_000;

/**
 * Fills in everything a table entry left out.
 *
 * The local schema follows the remote one unless it is given, so configuring
 * neither puts the table in `public` at both ends.
 */
function asConfig(entry: SupapowerTableConfig | string): ResolvedTableConfig {
  const config = typeof entry === 'string' ? { table: entry } : entry;
  const schema = config.schema ?? 'public';

  return {
    ...config,
    schema,
    localSchema: config.localSchema ?? schema,
    primaryKey: config.primaryKey ?? 'id',
    access: config.access ?? 'authenticated',
  };
}

/**
 * Where a table is queued, named, and keyed: locally.
 */
const localName = ({ localSchema, table }: ResolvedTableConfig): string =>
  escapeIdentifier(localSchema, table);

/**
 * What the table is called upstream, for anything Supabase was asked about.
 */
const remoteName = ({ schema, table }: ResolvedTableConfig): string =>
  escapeIdentifier(schema, table);

/**
 * The local key for a table named the way the application configured it:
 * `"todos"`, or `"app.todos"` when the same table name is configured in more
 * than one remote schema.
 */
export function tableKey(tables: Map<string, ResolvedTableConfig>, name: string): string {
  const matches = [...tables].filter(
    ([, config]) =>
      name === config.table
      || name === `${config.schema}.${config.table}`
      || name === escapeIdentifier(config.schema, config.table),
  );

  const [first] = matches;

  if (matches.length !== 1 || !first) {
    throw new SupapowerError(
      matches.length === 0
        ? `No table named "${name}" is configured for syncing`
        : `"${name}" matches more than one configured table; name it as "<schema>.<table>"`,
      { code: 'schema_mismatch' },
    );
  }

  return first[0];
}

/**
 * Fills in the defaults for each table entry and keys them by {@link localName}.
 *
 * Keyed on the local side because that is the side everything else has in
 * hand: a queued change records the schema its trigger fired in, and two
 * remote schemas flattened into one local one are one local table.
 */
export function resolveTables(
  tables: Array<SupapowerTableConfig | string>,
): Map<string, ResolvedTableConfig> {
  return new Map(
    tables.map((entry) => {
      const config = asConfig(entry);

      return [localName(config), config];
    }),
  );
}

/**
 * Describes each resolved table against the local database.
 *
 * @param columns The local columns per table, from `readLocalColumns`, keyed
 *   the same way the configs are.
 */
export function withLocalColumns(
  configs: Map<string, ResolvedTableConfig>,
  columns: Map<string, readonly string[]>,
): Map<string, SupapowerSyncedTable> {
  const described = new Map<string, SupapowerSyncedTable>();

  for (const [name, config] of configs) {
    described.set(name, { ...config, columns: columns.get(name) ?? [] });
  }

  return described;
}

/** The tables one session syncs, in the two sets the sync loops need. */
export interface SessionTables {
  /**
   * Every table this session may reach, scoped to the filter it resolved to.
   *
   * What the outgoing queue drains: an upload does not depend on the filter,
   * so a table whose filter could not be resolved still pushes its changes.
   */
  readonly reachable: Map<string, SupapowerScopedTable>;
  /**
   * The reachable tables that are also downloaded and subscribed.
   *
   * A table whose filter callback threw is left out - pulling it unfiltered
   * would fetch exactly the rows the filter exists to keep out.
   */
  readonly syncing: Map<string, SupapowerScopedTable>;
}

/**
 * Scopes each described table to one session: which rows it syncs, and
 * whether this session may read it at all.
 *
 * Runs again whenever a filter resolves to something else, which is what the
 * supervisor restarts a session for.
 *
 * @param resolved Every table's filter for this session, from `resolveFilters`.
 *   A table left out of `filters` gets `resolvedFilter: null`.
 * @param signedIn Whether anybody is signed in. With nobody, only the `anon`
 *   tables are reachable - see `access` in `SupapowerTableConfig`.
 * @returns The tables reachable (uploads) and syncing (downloads and subscribes) for this session.
 */
export function tablesForSession(
  tables: Map<string, SupapowerSyncedTable>,
  { filters, failed }: ResolvedFilters,
  signedIn: boolean,
): SessionTables {
  const reachable = new Map<string, SupapowerScopedTable>();
  const syncing = new Map<string, SupapowerScopedTable>();

  for (const [name, table] of tables) {
    if (!signedIn && table.access !== 'anon') {
      continue;
    }

    const scoped: SupapowerScopedTable = { ...table, resolvedFilter: filters.get(name) ?? null };

    reachable.set(name, scoped);

    if (!failed.has(name)) {
      syncing.set(name, scoped);
    }
  }

  return { reachable, syncing };
}

function tableFor(
  change: ChangeRow,
  tables: Map<string, ResolvedTableConfig>,
): ResolvedTableConfig {
  const name = escapeIdentifier(change.schema_name, change.table_name);
  const config = tables.get(name);

  if (!config) {
    throw new SupapowerError(
      `Local changes are queued for ${name}, which is not configured for syncing`,
      { code: 'schema_mismatch' },
    );
  }

  return config;
}

/**
 * The remote table, in whichever schema it was configured for.
 *
 * Always through `schema()`, even for `public`: the client's own default
 * schema is the application's setting, and a table's schema is Supapower's.
 */
function remote(supabase: SupabaseClient, { schema, table }: ResolvedTableConfig) {
  return supabase.schema(schema).from(table);
}

/**
 * Pushes one queued change upstream.
 *
 * The statements are idempotent on purpose: a crash between the upstream write
 * and {@link SyncTransaction.commit} leaves the batch queued, so the next
 * leader sends it again.
 */
/**
 * The columns an update actually changed.
 *
 * Both sides come from `to_jsonb(row)` and jsonb normalizes key order, so
 * comparing the serialized values is enough - no deep equality needed. A column
 * edited back to the value it started with drops out on its own.
 */
function changedColumns(change: UpdateChange): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(change.new_data).filter(
      ([column, value]) => JSON.stringify(value) !== JSON.stringify(change.old_data[column]),
    ),
  );
}

function uploadFailed(
  operation: string,
  table: string,
  error: PostgrestError,
): SupapowerUploadError {
  return new SupapowerUploadError(
    `Could not push a ${operation} on ${table} to Supabase: ${error.message}`,
    { cause: error },
  );
}

/**
 * Pushes one queued change upstream.
 *
 * An update sends only the columns it changed, so a row edited in two places at
 * once keeps both edits. See "Conflicts" in the readme.
 *
 * Everything here is idempotent: a crash between the upload and
 * {@link SyncTransaction.commit} leaves the batch queued for the next leader.
 *
 * @returns Whether Supabase actually changed anything. An update or delete that
 *   matched no row did not, and the caller reports it.
 */
async function pushChange(
  supabase: SupabaseClient,
  config: ResolvedTableConfig,
  change: ChangeRow,
): Promise<boolean> {
  const { primaryKey } = config;
  const name = remoteName(config);

  if (change.operation === 'INSERT') {
    const { error } = await remote(supabase, config).upsert(change.new_data, {
      onConflict: primaryKey,
    });

    if (error) {
      throw uploadFailed(change.operation, name, error);
    }

    return true;
  }

  // A write is asked to count what it touched. Row-level security filters a
  // forbidden row out of the `USING` clause rather than raising, so without the
  // count a denied write is indistinguishable from a successful one.
  if (change.operation === 'DELETE') {
    const { error, count } = await remote(supabase, config)
      .delete({ count: 'exact' })
      .eq(primaryKey, change.old_data[primaryKey]);

    if (error) {
      throw uploadFailed(change.operation, name, error);
    }

    // `null` means the server did not report a count; only a definite zero is
    // worth telling anybody about.
    return count !== 0;
  }

  const changed = changedColumns(change);

  if (Object.keys(changed).length === 0) {
    return true; // an update that moved nothing, which upstream already agrees with
  }

  const { error, count } = await remote(supabase, config)
    .update(changed, { count: 'exact' })
    .eq(primaryKey, change.old_data[primaryKey]);

  if (error) {
    throw uploadFailed(change.operation, name, error);
  }

  return count !== 0;
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
  /** Dispatched for `uploadStart`/`uploadFinish`/`error`. @default A fresh, unlistened `EventTarget`. */
  events?: SupapowerEventTarget;
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
 * An UPDATE or DELETE that matches no row is reported through the `error`
 * event, not thrown. It looks the same as a batch re-sent after a crash, so
 * the queue keeps moving and the application decides whether it was a
 * divergence.
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
  events = createSupapowerEvents(),
}: OutgoingSyncOptions): Promise<void> {
  let attempt = 0;

  while (!signal.aborted) {
    try {
      for await (const { batch, commit } of getNextSyncTransaction(pg, tables, signal)) {
        events.dispatchEvent(new Event('uploadStart'));

        let rejected: ChangeRow | undefined;

        try {
          for (const change of batch) {
            if (signal.aborted) {
              return; // leadership is gone; leave the batch for the next leader
            }

            rejected = change;

            const config = tableFor(change, tables);
            const applied = await pushChange(supabase, config, change);

            if (!applied) {
              // Not thrown: a batch re-sent after a crash also matches nothing
              // the second time, and failing here would wedge the queue on a
              // change that can never succeed again.
              events.dispatchEvent(
                new SupapowerErrorEvent(
                  new SupapowerError(
                    `Supabase ignored a ${change.operation} on ${remoteName(config)}: no row matched. The row may be gone, or row-level security may be hiding it from this user.`,
                    { code: change.operation === 'DELETE' ? 'delete_ignored' : 'update_ignored' },
                  ),
                ),
              );
            }
          }

          if (signal.aborted) {
            return;
          }

          await commit();
          events.dispatchEvent(new Event('uploadFinish'));
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

          events.dispatchEvent(new Event('uploadFinish'));
        }
      }

      attempt = 0;

      await waitForChanges(pg, signal, IDLE_POLL_MS);
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      events.dispatchEvent(
        new SupapowerErrorEvent(
          asSupapowerError(error, 'The outgoing sync failed', 'upload_failed'),
        ),
      );

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
 * one.
 *
 * A row with a local change still waiting in the outgoing queue is left alone.
 * See "Conflicts" in the readme for why the local version wins, and what that
 * costs.
 *
 * The row goes where the configuration says it lives locally, not where the
 * payload says it came from - the two differ whenever `localSchema` is set.
 *
 * @param pg The PGlite interface or transaction to execute the change within.
 * @param payload The payload describing the incoming change from Supabase.
 */
export async function handleIncomingChange(
  pg: PGliteInterface | Transaction,
  payload: RealtimePostgresChangesPayload<Record<string, unknown>>,
  {
    table,
    localSchema,
    primaryKey,
    columns: local,
  }: Pick<SupapowerSyncedTable, 'table' | 'localSchema' | 'primaryKey' | 'columns'>,
): Promise<readonly string[]> {
  const columns: string[] = [];
  const parameters: unknown[] = [];
  const ignored: string[] = [];

  const removing = payload.eventType === 'DELETE';
  const rowId = removing ? payload.old[primaryKey] : payload.new[primaryKey];

  if (removing) {
    // Typed by the column it is compared against, unlike the text copy the
    // guard below needs for its jsonb lookup.
    parameters.push(rowId);
  } else {
    for (const [column, value] of Object.entries(payload.new)) {
      // A column the server has and this client does not. Naming it in the
      // statement would fail the whole change with 42703, so it is left out and
      // handed back for the caller to report.
      if (!local.includes(column)) {
        ignored.push(column);
        continue;
      }

      columns.push(column);
      parameters.push(value);
    }
  }

  // The row is left alone while a local change to it is still queued. Since an
  // upload sends the whole row, that queued change is about to overwrite this
  // one upstream anyway - dropping it here just means local and remote agree
  // now rather than after the round trip.
  //
  // `push` returns the new length, so this is where the four of them start.
  const guard = parameters.push(localSchema, table, primaryKey, String(rowId)) - 3;

  const unchanged = `
    NOT EXISTS (
      SELECT 1 FROM supapower.changes
      WHERE schema_name = $${guard}
        AND table_name = $${guard + 1}
        AND COALESCE(new_data, old_data) ->> $${guard + 2} = $${guard + 3}
    )`;

  // Where the row goes locally, which is not where it came from when the two
  // schemas differ.
  const relation = escapeIdentifier(localSchema, table);

  const query = removing
    ? `
      DELETE FROM ${relation}
      WHERE ${escapeIdentifier(primaryKey)} = $1
        AND ${unchanged}
    `
    : // INSERT and UPDATE are the same statement: the payload carries the whole
      // new row either way, and upserting makes an update land even when the
      // row was never inserted locally - a missed insert would otherwise leave
      // an UPDATE matching nothing at all.
      `
      INSERT INTO ${relation} (
        ${columns.map((column) => escapeIdentifier(column)).join(',\n        ')}
      )
      SELECT
        ${columns.map((_, index) => `$${index + 1}`).join(',\n        ')}
      WHERE ${unchanged}
      ON CONFLICT (${escapeIdentifier(primaryKey)}) DO UPDATE SET
        ${columns.map((column) => `${escapeIdentifier(column)} = EXCLUDED.${escapeIdentifier(column)}`).join(',\n        ')}
    `;

  await executeInTransaction(pg, async (tx) => {
    await tx.sql`SELECT set_config('supapower.applying', 'true', true)`;

    await tx.query(query, parameters);
  });

  return ignored;
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

  return pg.transaction(async (tx) => {
    const toClearCursorFor: string[] = [];

    for (const [key, { table, localSchema, access }] of tables) {
      if (access !== 'authenticated') {
        continue;
      }

      toClearCursorFor.push(key);

      // TRUNCATE only fires TRUNCATE triggers, so this does not queue itself up
      // as a pile of outgoing deletes.
      await tx.query(`TRUNCATE TABLE ${key}`);

      await tx.sql`
        DELETE FROM supapower.changes
        WHERE schema_name = ${localSchema} AND table_name = ${table}
      `;
    }

    await clearTableSyncState(tx, toClearCursorFor);

    await setSyncedUser(tx, user);

    return toClearCursorFor.length > 0;
  });
}

/**
 * Empties the local table for a table whose resolved filter has changed since
 * its last download.
 *
 * Both narrowing and widening a filter truncate: rows only ever arrive as
 * upserts, and neither a filtered download nor a filtered subscription ever
 * reports a row that stopped matching, so a narrowed filter would otherwise
 * leave those rows behind forever, and a widened one cannot be told apart
 * from a narrowed one here.
 *
 * Unlike {@link reconcileUser}, queued `supapower.changes` rows are left
 * alone: a changed filter does not make the user's pending writes somebody
 * else's.
 *
 * @returns The tables that were truncated, as their qualified local names.
 */
export async function reconcileFilters(
  pg: PGliteInterface,
  tables: Map<string, SupapowerScopedTable>,
): Promise<string[]> {
  const changed: string[] = [];

  for (const [key, { resolvedFilter }] of tables) {
    const state = await getTableSyncState(pg, key);

    // A table that never finished a download has nothing to empty - whatever
    // is there arrives filtered either way.
    if (state && (state.filter ?? '') !== (resolvedFilter?.expression ?? '')) {
      changed.push(key);
    }
  }

  if (changed.length === 0) {
    return changed; // nothing to empty, so no transaction to open
  }

  await pg.transaction(async (tx) => {
    for (const key of changed) {
      // TRUNCATE only fires TRUNCATE triggers, so this does not queue itself
      // up as a pile of outgoing deletes.
      await tx.query(`TRUNCATE TABLE ${key}`);
    }

    await clearTableSyncState(tx, changed);
  });

  return changed;
}

/** Dresses a downloaded row up as the INSERT event it would have been. */
function asInsertEvent(
  { schema, table }: ResolvedTableConfig,
  row: Record<string, unknown>,
  snapshotAt: string,
): RealtimePostgresInsertPayload<Record<string, unknown>> {
  return {
    eventType: 'INSERT',
    schema,
    table,
    commit_timestamp: snapshotAt,
    new: row,
    old: {},
    errors: [],
  };
}

/** Quotes a column for a PostgREST `select`, which only needs it sometimes. */
function selectable(column: string): string {
  return /^[a-z_][\w$]*$/i.test(column) ? column : escapeIdentifier(column);
}

/**
 * Whether a stored watermark still answers the question being asked.
 *
 * It was collected from one cursor column, covering one set of columns. Ask
 * for a column that download never requested and the watermark would skip
 * every row that has not changed since - so it only holds while the columns
 * wanted now are ones it already covered.
 */
function stillApplies(
  state: TableSyncState | null,
  config: SupapowerSyncedTable,
): state is TableSyncState {
  return (
    state !== null
    && state.cursor === config.cursor
    && config.columns.every((column) => state.columns.includes(column))
  );
}

interface DownloadTableOptions {
  pg: PGliteInterface;
  supabase: SupabaseClient;
  config: SupapowerScopedTable;
  signal: AbortSignal;
  events: SupapowerEventTarget;
  /** How long the last completed download of this table counts as fresh. */
  throttle: number;
}

async function downloadTable({
  pg,
  supabase,
  config,
  signal,
  events,
  throttle,
}: DownloadTableOptions): Promise<void> {
  const { cursor, columns, primaryKey, resolvedFilter } = config;
  const name = localName(config);

  const stored = await getTableSyncState(pg, name);
  const requested = await getRefreshRequest(pg, name);

  // A redownload asked for since the last completed download. Compared for
  // equality, not recency: the token that finished a download is the only one
  // that counts as answered, so a request that lands while that download is
  // in flight is still pending afterwards.
  const pending = requested !== undefined && requested !== stored?.refresh;

  const previous = !pending && stillApplies(stored, config) ? stored : null;
  const age = previous ? Date.now() - previous.downloadedAt : Number.NaN;

  // A download that still answers this configuration and finished inside the
  // window is not worth repeating - leadership moves between tabs on every
  // switch, and each move would otherwise pull every table whole again. A
  // clock that jumped backwards leaves a timestamp in the future, which counts
  // as stale rather than freezing the table until the clock catches up.
  if (age >= 0 && age < throttle) {
    return;
  }

  events.dispatchEvent(new SupapowerTableEvent('downloadTableStart', config));

  if (pending) {
    // Neither a filtered download nor RLS ever reports a row that stopped
    // being visible, so a redownload can only describe the table completely
    // by starting from empty. TRUNCATE fires TRUNCATE triggers only, so this
    // does not queue itself up as a pile of outgoing deletes.
    await pg.query(`TRUNCATE TABLE ${name}`);
  }

  // Taken before the request so a change made while it is in flight is dated
  // after the snapshot rather than swallowed by it.
  const snapshotAt = new Date().toISOString();

  const since = previous?.at === undefined ? Number.NaN : Date.parse(previous.at);

  // Where an incremental download starts: {@link CURSOR_MARGIN_MS} further back
  // than the last value seen. A watermark that is not a timestamp gives up and
  // pulls the whole table rather than guessing at how to step back from it.
  const from = Number.isNaN(since) ? null : new Date(since - CURSOR_MARGIN_MS).toISOString();

  // Seeded with the value already stored, so the same comparison that finds the
  // furthest along row also keeps the watermark moving only forwards - and so a
  // download that returns nothing new writes the old value back instead of
  // dropping it.
  let highest: string | null = previous?.at ?? null;

  // A hard deleted row can drag the highest value in the table backwards, and
  // reaching further back next time is pointless.
  let highestAt = Number.isNaN(since) ? Number.NEGATIVE_INFINITY : since;

  // Keyset paged on the primary key: Supabase caps a single response at
  // {@link DOWNLOAD_PAGE_SIZE} rows, so one request would silently truncate any
  // table bigger than that. Paging stops on an empty page rather than a short
  // one - a project configured with a lower cap would otherwise return a short
  // page for a table that still has more rows, and stopping there would
  // reintroduce the truncation this loop exists to remove.
  let last: unknown = null;

  for (;;) {
    // Asking for the columns this client has keeps a column it does not know
    // about out of the download entirely, rather than trimming it off on arrival.
    const select = remote(supabase, config).select(columns.map(selectable).join(','));
    const scoped = resolvedFilter ? applyFilter(select, resolvedFilter) : select;
    const incremental = cursor && from ? scoped.gte(cursor, from) : scoped;
    const paged = last === null ? incremental : incremental.gt(primaryKey, last);

    const { data, error } = await paged
      .order(primaryKey, { ascending: true })
      .limit(DOWNLOAD_PAGE_SIZE)
      .overrideTypes<Array<Record<string, unknown>>, { merge: false }>();

    if (error) {
      throw new SupapowerError(
        `Could not download ${remoteName(config)} from Supabase: ${error.message}`,
        { code: 'download_failed', cause: error },
      );
    }

    if (signal.aborted) {
      return; // cut short by a leadership change; not a finish
    }

    if (data.length === 0) {
      break;
    }

    // Each page applies atomically, not the whole table: a partially
    // downloaded table is indistinguishable from a not-yet-downloaded one,
    // because every row is an upsert on the primary key.
    await pg.transaction(async (tx) => {
      for (const row of data) {
        await handleIncomingChange(tx, asInsertEvent(config, row, snapshotAt), config);

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
    });

    const lastKey = data[data.length - 1]?.[primaryKey];

    if (lastKey === null || lastKey === undefined) {
      events.dispatchEvent(
        new SupapowerErrorEvent(
          new SupapowerError(
            `Could not page ${remoteName(config)}: a row came back without a "${primaryKey}"`,
            { code: 'download_failed' },
          ),
        ),
      );

      return;
    }

    last = lastKey;
  }

  // Written once, after the whole table has paged through: a record written
  // mid-table would claim coverage of rows that ordering by primary key has
  // not reached yet. It must stay unconditional - every table gets a fresh
  // record, not only ones with a cursor and rows that moved the watermark -
  // and it must stay last: the early returns above (aborted signal, a row
  // without a primary key) and a thrown download error are unfinished
  // downloads that must not count as fresh.
  await setTableSyncState(pg, name, {
    downloadedAt: Date.now(),
    columns: [...columns],
    ...(cursor === undefined ? {} : { cursor }),
    ...(highest === null ? {} : { at: highest }),
    ...(resolvedFilter === null ? {} : { filter: resolvedFilter.expression }),
    ...(requested === undefined ? {} : { refresh: requested }),
  });

  events.dispatchEvent(new SupapowerTableEvent('downloadTableFinish', config));
}

export interface InitialSyncOptions {
  pg: PGliteInterface;
  supabase: SupabaseClient;
  /** The tables to download, in the order they should be downloaded. */
  tables: Map<string, SupapowerScopedTable>;
  signal: AbortSignal;
  /**
   * Dispatched for `downloadStart`/`downloadFinish`/`downloadTableStart`/`downloadTableFinish`.
   *
   * @default A fresh, unlistened `EventTarget`.
   */
  events?: SupapowerEventTarget;
  /**
   * How long a table's last completed download stays fresh, in milliseconds.
   *
   * A table that finished downloading more recently than this is skipped;
   * `0` downloads every table on every pass.
   *
   * @default 60_000
   */
  downloadThrottle?: number;
}

/**
 * Downloads every row of every table and writes it into the local database.
 *
 * A table configured with a `cursor` column is only asked for rows at or after
 * the last value downloaded, less a margin; one without is pulled whole again
 * once `downloadThrottle` has passed since it last finished. Either way the
 * rows go through the same path as a realtime INSERT, so the upsert on the
 * primary key makes re-running it harmless.
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
  events = createSupapowerEvents(),
  downloadThrottle = DOWNLOAD_THROTTLE_MS,
}: InitialSyncOptions): Promise<void> {
  events.dispatchEvent(new Event('downloadStart'));

  for (const config of tables.values()) {
    if (signal.aborted) {
      return;
    }

    await downloadTable({ pg, supabase, config, signal, events, throttle: downloadThrottle });
  }

  events.dispatchEvent(new Event('downloadFinish'));
}

export interface IncomingSyncOptions {
  pg: PGliteInterface;
  supabase: SupabaseClient;
  /**
   * The tables to subscribe to.
   *
   * Already filtered for the current user - deciding which tables are
   * reachable is the caller's job, see `access` in `SupapowerTableConfig`.
   * The filters are already resolved for this session, the same as `access`
   * is already applied.
   */
  tables: Map<string, SupapowerScopedTable>;
  /**
   * Aborted when leadership is lost, when the signed in user changes, or when
   * the sync is unsubscribed.
   */
  signal: AbortSignal;
  /** Overrides the generated channel name. */
  channel?: string;
  /**
   * Dispatched for `error` and, on catch-up, the download events.
   * @default A fresh, unlistened `EventTarget`.
   */
  events?: SupapowerEventTarget;
  /**
   * How long a table's last completed download stays fresh, in milliseconds.
   *
   * Applies to the download that starts the session. The catch-up download
   * after a dropped channel ignores it.
   *
   * @default 60_000
   */
  downloadThrottle?: number;
}

/**
 * Applies remote changes locally for as long as the signal is live.
 *
 * Subscribes one realtime channel to `postgres_changes` on every table it is
 * given and writes each change straight into the local database, with
 * `supapower.applying` set so the change triggers do not queue it right back up
 * as an outgoing change.
 *
 * A download runs behind the subscription, and again whenever the channel comes
 * back after dropping. A rejoin replays nothing, so without that second one
 * every change made during the outage would be lost until something else forced
 * a whole download.
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
  events = createSupapowerEvents(),
  downloadThrottle = DOWNLOAD_THROTTLE_MS,
}: IncomingSyncOptions): Promise<void> {
  if (signal.aborted || tables.size === 0) {
    return; // nothing this user is allowed to see
  }

  // Realtime hands us its callbacks synchronously while applying a change is
  // async, so the work is chained: two updates to the same row have to land in
  // the order they were broadcast.
  let applying: Promise<void> = Promise.resolve();

  // Resolves `true` once `task` has run, `false` if it was skipped by an
  // abort or failed and dispatched an `error` event - so a caller such as
  // `download` below can tell a real failure apart from a completed run.
  const enqueue = (task: () => Promise<void>): Promise<boolean> => {
    const previous = applying;

    const done = (async () => {
      await previous;

      if (signal.aborted) {
        return false;
      }

      try {
        await task();

        return true;
      } catch (error: unknown) {
        // Caught per task so one bad row cannot break the chain for the rest.
        events.dispatchEvent(
          new SupapowerErrorEvent(
            asSupapowerError(error, 'Could not apply a remote change', 'apply_failed'),
          ),
        );

        return false;
      }
    })();

    applying = done.then(() => undefined);

    return done;
  };

  // Reported once per column per session: a schema that has drifted drifts for
  // every row, and one notice is the useful part.
  const reported = new Set<string>();

  const reportIgnored = (table: string, ignored: readonly string[]) => {
    const fresh = ignored.filter((column) => !reported.has(`${table}.${escapeIdentifier(column)}`));

    if (fresh.length === 0) {
      return;
    }

    for (const column of fresh) {
      reported.add(`${table}.${escapeIdentifier(column)}`);
    }

    events.dispatchEvent(
      new SupapowerErrorEvent(
        new SupapowerError(
          `Ignored ${fresh.map((column) => escapeIdentifier(column)).join(', ')} from a remote change to ${table}: this client's schema has no such column`,
          { code: 'column_ignored' },
        ),
      ),
    );
  };

  const apply = (
    payload: RealtimePostgresChangesPayload<Record<string, unknown>>,
    config: SupapowerSyncedTable,
  ) =>
    enqueue(async () => {
      reportIgnored(remoteName(config), await handleIncomingChange(pg, payload, config));
    });

  let subscription = supabase.channel(channel);

  for (const config of tables.values()) {
    subscription = subscription.on(
      'postgres_changes',
      {
        event: '*',
        schema: config.schema,
        table: config.table,
        ...(config.resolvedFilter ? { filter: config.resolvedFilter.expression } : {}),
      },
      (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => apply(payload, config),
    );
  }

  // Guards against a second retry loop working through the same download at
  // the same time; `download()` never rejects, so every call site can fire it
  // without awaiting.
  let downloading = false;

  // Whether another pass was asked for while one was running, and whether that
  // pass has to ignore the throttle.
  let again = false;
  let againForced = false;

  const download = async (force = false): Promise<void> => {
    if (downloading) {
      again = true;
      againForced ||= force;

      return;
    }

    downloading = true;

    try {
      let forced = force;

      do {
        again = false;
        againForced = false;

        for (let attempt = 0; !signal.aborted; attempt += 1) {
          if (
            await enqueue(() =>
              runInitialSync({
                pg,
                supabase,
                tables,
                signal,
                events,
                downloadThrottle: forced ? 0 : downloadThrottle,
              }),
            )
          ) {
            break;
          }

          // Outside `enqueue`, so realtime changes keep applying between
          // attempts; only the attempt itself occupies the `applying` chain.
          await backOff(signal, attempt);
        }

        forced = againForced;
      } while (again && !signal.aborted);
    } finally {
      downloading = false;
    }
  };

  // Whether the channel has dropped since the last download. realtime-js
  // rejoins on its own but replays nothing, so anything that changed while it
  // was away has to be fetched rather than waited for.
  let missedChanges = false;

  // Tracked so `connect`/`disconnect` only fire on an actual transition, not
  // on every reported hiccup while already down.
  let connected = false;

  const closed = new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });

    subscription.subscribe((status, error) => {
      if (status === REALTIME_SUBSCRIBE_STATES.CLOSED) {
        return; // what unsubscribing looks like from in here
      }

      if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
        connected = true;
        events.dispatchEvent(new Event('connect'));

        if (missedChanges) {
          missedChanges = false;
          // Realtime replays nothing, so the outage gap is exactly the data
          // this client is missing; throttling it away would strand those rows.
          download(true);
        }

        return;
      }

      // CHANNEL_ERROR and TIMED_OUT are reported but not acted on beyond this:
      // realtime-js rejoins on its own, and tearing the channel down here would
      // fight it. The catch-up happens when it comes back.
      missedChanges = true;

      if (connected) {
        connected = false;
        events.dispatchEvent(new Event('disconnect'));
      }

      events.dispatchEvent(
        new SupapowerErrorEvent(
          asSupapowerError(
            error,
            `Realtime channel "${channel}" reported ${status}`,
            'connection_failed',
          ),
        ),
      );
    });
  });

  // A `redownload()` from any tab: the request itself is already in the
  // database, so this is only a wake - a tab that starts downloading later
  // honours it on its own.
  const unlisten = await pg.listen(REFRESH_CHANNEL, () => {
    download();
  });

  // Subscribe first, download second: a change made while the snapshot is in
  // flight arrives on the open channel and queues up behind it, rather than
  // falling in the gap between the two.
  download();

  try {
    await closed;
  } finally {
    if (connected) {
      events.dispatchEvent(new Event('disconnect'));
    }

    // `allSettled`, not `all`: a rejected `removeChannel()` must not cut the
    // wait for `applying` short - the caller awaits this to know teardown is
    // done, including changes still mid-apply.
    const [removed] = await Promise.allSettled([
      supabase.removeChannel(subscription),
      applying,
      unlisten(),
    ]);

    if (removed.status === 'rejected') {
      // Reported, not thrown: the caller awaits this to know the teardown is
      // done, and a socket that could not be told goodbye does not change that.
      events.dispatchEvent(
        new SupapowerErrorEvent(
          asSupapowerError(
            removed.reason,
            `Could not leave the realtime channel "${channel}"`,
            'connection_failed',
          ),
        ),
      );
    }
  }
}
