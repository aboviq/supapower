import type { PGliteInterface } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { UnrecoverableUploadError } from './changes.js';
import type { SupapowerError } from './errors.js';
import type { SupapowerEventTarget } from './events.js';
import type { LeadershipStrategy } from './leadership.js';

export interface SupapowerTableConfig {
  /**
   * Table name
   *
   * The data from the remote table (in Supabase) is synced to the local table (in PGlite) with the same name
   */
  table: string;

  /**
   * Schema the table lives in remotely, in Supabase.
   *
   * It has to be exposed in the project's Data API settings, and its tables
   * added to the realtime publication, the same as `public`.
   *
   * Unless {@link localSchema} says otherwise, the local table is expected in
   * this schema too.
   *
   * @default "public"
   */
  schema?: string;

  /**
   * Schema the table lives in locally, in PGlite, when that is not the schema
   * it lives in remotely.
   *
   * Use it to keep synced tables apart from the rest of the local database, or
   * to flatten several remote schemas into one local one. The remote side is
   * unaffected and stays on {@link schema}.
   *
   * @default The table's remote {@link schema}
   */
  localSchema?: string;

  /**
   * Primary key column name
   *
   * All synced tables should have a single column primary key.
   * If not specified it's assumed to be named "id".
   *
   * @default "id"
   */
  primaryKey?: string;

  /**
   * Name of a timestamp column that is set to the current time on every write,
   * typically `updated_at`.
   *
   * Given one, the download after the first only asks for rows at or after the
   * last one it saw, instead of pulling the whole table again. Without one every
   * start is a full download.
   *
   * The column has to move on **every** change that should reach the client,
   * deletions included - see the schema recommendations in the readme. A row
   * whose timestamp does not move is invisible to an incremental download.
   *
   * Hard `DELETE`s cannot be picked up this way, since the row is simply gone.
   * Use soft deletes, or accept that removals only arrive over realtime while
   * the client is connected.
   */
  cursor?: string;

  /**
   * Who can access the remote table?
   *
   * Use 'anon' for tables accessible by anyone, i.e. even those not signed in.
   * Such tables will be synced immediately and won't be emptied when a user signs in or out.
   *
   * Use 'authenticated' for tables that should only be synced for authenticated users.
   * Such tables will be emptied both on sign in (before initial sync) and sign out to make sure data for different users are not mixed in the local database.
   */
  access?: 'anon' | 'authenticated';
}

/** A table entry with every default filled in. */
export interface ResolvedTableConfig extends SupapowerTableConfig {
  /** The schema the table lives in remotely, in Supabase. */
  schema: string;
  /** The schema the table lives in locally, in PGlite. */
  localSchema: string;
  primaryKey: string;
  access: 'anon' | 'authenticated';
}

/**
 * A resolved table, described against the local database.
 *
 * Only the parts of the sync that read `columns` ask for one; the rest make do
 * with a {@link ResolvedTableConfig}.
 */
export interface SupapowerSyncedTable extends ResolvedTableConfig {
  /**
   * The columns the table has in the local database, sorted.
   *
   * The application owns the local schema, and it lags behind the remote one
   * whenever the server deploys first, so this is what an incoming row is
   * trimmed to fit.
   */
  columns: readonly string[];
}

export interface SupapowerSyncOptions {
  /**
   * Supabase client instance used for syncing data with the remote tables.
   *
   * Supabase's Data API is used for initial and outgoing data synchronization.
   * The Realtime API and its "postgres_changes" feature is used for listening to changes
   * in the remote tables and keeping the local tables in sync in real-time.
   *
   * The Auth API is used for knowing when to truncate/empty the local tables based on the user's authentication state.
   */
  supabase: SupabaseClient;
  /**
   * Configuration for the tables to sync
   *
   * Only tables configured will be synced and their corresponding
   * local tables must exist before starting the sync.
   *
   * The order of the tables in this array determines the order in which the initial sync is performed.
   */
  tables: Array<SupapowerTableConfig | string>;
  /**
   * An optional AbortSignal to cancel the sync operation.
   *
   * Aborting it is equivalent to calling {@link SupapowerSync.unsubscribe}. An
   * event listener cannot be awaited, so call `unsubscribe()` as well when you
   * need to know the teardown has finished - it is idempotent and returns the
   * same promise.
   */
  signal?: AbortSignal;
  /**
   * Name identifying this database, used to scope the cross-tab lock that keeps
   * a single tab in charge of the outgoing queue.
   *
   * Only relevant when syncing a plain `PGlite` instance in a browser - a
   * `PGliteWorker` brings its own leader election, which is already scoped to
   * its data directory. Give two apps on the same origin different scopes so
   * they don't compete for one lock.
   *
   * @default "default"
   */
  scope?: string;
  /**
   * How long a table's last completed download stays fresh, in milliseconds.
   *
   * Leadership follows tab visibility, so switching to another tab starts a
   * fresh syncer - and a table without a `cursor` is downloaded whole each time
   * one starts. A table that finished downloading more recently than this is
   * skipped instead; `0` turns the throttle off and downloads everything every
   * time.
   *
   * Two things ignore it, because neither is a repeat of work already done: the
   * catch-up after a dropped realtime connection, and a table whose configured
   * cursor or local columns have changed since it was last downloaded.
   *
   * @default 60_000
   */
  downloadThrottle?: number;
  /**
   * Decides what happens to a batch of local changes that Supabase rejects for
   * a reason retrying cannot fix - a data type mismatch, a constraint
   * violation, or a row-level security denial.
   *
   * These usually mean a bug in the application rather than a hiccup on the
   * network, and the rejected batch blocks every later change behind it, so by
   * default Supapower discards it to keep the queue moving. Override this when
   * losing the data is not acceptable: save the batch elsewhere, tell the user,
   * or park it - and call `commit()` once you have, since returning without
   * calling it leaves the batch queued for another attempt after a backoff.
   *
   * Transient failures never reach this callback; they are simply retried.
   *
   * ```ts
   * onUnrecoverableError: async ({ error, batch, change, commit }) => {
   *   await reportToSentry(error, { change });
   *   await quarantine(batch);
   *   await commit();
   * }
   * ```
   *
   * @default Discards the batch.
   */
  onUnrecoverableError?: (context: UnrecoverableUploadError) => void | Promise<void>;
}

export interface SupapowerSync {
  /**
   * How the single active syncer is elected across tabs and processes.
   *
   * Exposed for diagnostics; `single-process` in a browser means several tabs
   * could be syncing at once, which is a sign the database should be opened
   * through `PGliteWorker`.
   */
  readonly leadership: LeadershipStrategy;

  /**
   * Unsubscribes from the ongoing sync, stopping any further synchronization of data with the remote tables.
   *
   * Local changes will still be tracked but the queue of outgoing changes will no longer be processed.
   *
   * Everything that can stop synchronously has stopped by the time this returns;
   * the promise resolves once the rest has too - leaving the realtime channel is
   * a round trip to the server, and a change being applied locally is awaited
   * out. Await it before tearing the Supabase client down or exiting the
   * process, ignore it to stop without waiting.
   *
   * Never rejects: anything that fails while stopping is reported through the
   * `error` event.
   *
   * Safe to call more than once - every call resolves with the same teardown.
   */
  unsubscribe(): Promise<void>;
}

/** A PowerSync-like snapshot of what the sync is doing, derived from the events. */
export interface SupapowerStatus {
  /**
   * Whether this tab or process is the one running the sync.
   *
   * Only the leader downloads, uploads and holds the realtime channel, so every
   * other field stays `false` in a follower tab - its data still arrives, through
   * the shared database.
   */
  leading: boolean;
  /** The realtime channel is subscribed and delivering changes. */
  connected: boolean;
  /** The sync is running and leading, but the channel is not delivering yet. */
  connecting: boolean;
  /** A download (initial or catch-up) is in progress. */
  downloading: boolean;
  /** A batch of local changes is uploading. */
  uploading: boolean;
  /** At least one full download has finished since `sync()` was called. */
  hasSynced: boolean;
  /** When the last full download finished. */
  lastSyncedAt: Date | undefined;
  /** The last download-side failure, cleared by the next finished download. */
  downloadError: SupapowerError | undefined;
  /** The last upload-side failure, cleared by the next finished upload. */
  uploadError: SupapowerError | undefined;
}

export interface SupapowerNamespace {
  /**
   * Events dispatched during the sync: `downloadStart`, `downloadFinish`,
   * `downloadTableStart`, `downloadTableFinish`, `uploadStart`,
   * `uploadFinish`, and `error` - the last replacing what used to be the
   * `onError` option.
   *
   * Exists as soon as the namespace does, so listeners can be attached before
   * `sync()` is ever called - nothing is dispatched until it is.
   */
  readonly events: SupapowerEventTarget;

  /**
   * The current sync status, derived from the events below.
   *
   * A getter which returns a new frozen object every time something changes, and a `statusChange`
   * event is dispatched on {@link SupapowerNamespace.events} with it. Exists
   * as soon as the namespace does; nothing changes until `sync()` is called.
   */
  readonly status: SupapowerStatus;

  /**
   * Initializes the local database and starts syncing with the remote tables based on the provided options.
   *
   * The local tables configured for syncing must exist before starting the sync.
   *
   * Only one tab or process drains the outgoing queue at a time; calling this
   * in every tab is both expected and required, since the tab in charge may
   * change at any time.
   *
   * @param options Options for configuring the sync process.
   */
  sync(options: SupapowerSyncOptions): Promise<SupapowerSync>;
}

/**
 * A PGlite instance with the Supapower extension enabled.
 */
export type PGliteWithSupapower = PGliteInterface & {
  supapower: SupapowerNamespace;
};
