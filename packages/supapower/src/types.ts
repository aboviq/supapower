import type { PGliteInterface } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { UnrecoverableUploadError } from './changes.js';
import type { SupapowerError } from './errors.js';
import type { LeadershipStrategy } from './leadership.js';

export interface SupapowerTableConfig {
  /**
   * Table name
   *
   * The data from the remote table (in Supabase) is synced to the local table (in PGlite) with the same name
   */
  table: string;

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
   * Aborting it is equivalent to calling {@link SupapowerSync.unsubscribe}.
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
  /**
   * Called for anything that went wrong but did not stop the sync.
   *
   * A failed upload or download that will be retried, a realtime channel
   * reporting trouble, a change that could not be applied locally, and a
   * `DELETE` that matched no row upstream - which is how row-level security
   * refuses a delete, since it filters the row out rather than raising.
   *
   * Purely for reporting: the sync carries on either way, and without this
   * callback every one of those passes silently.
   *
   * Anything that is not already a `SupapowerError` is wrapped in one, so
   * `code` is always there to switch on and the original failure is always
   * reachable through `cause`.
   */
  onError?: (error: SupapowerError) => void;
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
   * Returns as soon as the sync has been signalled to stop. Leaving the realtime
   * channel is a round trip to the server and settles shortly afterwards, so do
   * not tear the Supabase client down in the same tick.
   *
   * Safe to call more than once.
   */
  unsubscribe(): void;
}

export interface SupapowerNamespace {
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
