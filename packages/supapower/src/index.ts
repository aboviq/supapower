import type { PGliteInterface } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { UnrecoverableUploadError } from './changes.js';
import type { SupapowerError } from './errors.js';
import { createLeadership } from './leadership.js';
import { runMigrations, trackTables } from './migrations.js';
import {
  reconcileUser,
  type ResolvedTableConfig,
  resolveTables,
  runIncomingSync,
  runOutgoingSync,
} from './sync.js';
import type { SupapowerNamespace, SupapowerSync, SupapowerSyncOptions } from './types.js';

/** Stands in for a client whose token the application owns. */
const EXTERNAL_AUTH = Symbol('external-auth');

/** What {@link EXTERNAL_AUTH} is recorded as, so a reload recognizes it again. */
const EXTERNAL_USER = 'supapower:external';

/** Who the tables are being synced for. `null` means nobody is signed in. */
type AuthIdentity = string | null | typeof EXTERNAL_AUTH;

/**
 * Follows who is signed in, starting with the session that is already there.
 *
 * Only the identity matters, not the token: supabase-js pushes a refreshed
 * token onto the realtime socket by itself, so a `TOKEN_REFRESHED` event needs
 * no reaction here.
 */
function watchAuthIdentity(
  supabase: SupabaseClient,
  onChange: (identity: AuthIdentity) => void,
): () => void {
  try {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      onChange(session?.user.id ?? null);
    });

    return () => data.subscription.unsubscribe();
  } catch {
    // A client built with the `accessToken` option replaces `supabase.auth`
    // with a proxy that throws on every access: the application owns the token,
    // so there is no auth state to follow and every table stays reachable.
    onChange(EXTERNAL_AUTH);

    return () => {};
  }
}

interface SyncSupervisorOptions {
  pg: PGliteInterface;
  supabase: SupabaseClient;
  tables: Map<string, ResolvedTableConfig>;
  /** Aborted when leadership is lost or the sync is unsubscribed. */
  signal: AbortSignal;
  onUnrecoverableError?: (context: UnrecoverableUploadError) => void | Promise<void>;
  onError?: (error: SupapowerError) => void;
}

/** The tables that are reachable for a given identity. */
function reachableTables(
  tables: Map<string, ResolvedTableConfig>,
  identity: AuthIdentity,
): Map<string, ResolvedTableConfig> {
  if (identity !== null) {
    return tables;
  }

  return new Map([...tables].filter(([, config]) => config.access === 'anon'));
}

/**
 * Runs both directions of the sync for whoever is signed in.
 *
 * Nothing starts until the auth client reports an identity. supabase-js queues
 * the first `onAuthStateChange` notification until its own initialization has
 * settled, so that callback doubles as an "authentication is ready" signal -
 * whether or not there turns out to be a session.
 *
 * Waiting matters most for the outgoing queue. Its HTTP requests already block
 * on the same initialization, since supabase-js resolves the token per request,
 * but a queue drained before the session is known is drained with whatever
 * token happens to exist. If the refresh token expired while the tab was
 * closed, that is the anon key, and every change to an `authenticated` table
 * comes back as a row-level security denial - which the outgoing loop treats as
 * unrecoverable and discards. Those changes stay queued instead.
 *
 * Both directions share one signal per identity, so signing out aborts an
 * upload in flight rather than letting it finish as the wrong user.
 */
function superviseSync({
  pg,
  supabase,
  tables,
  signal,
  onUnrecoverableError,
  onError,
}: SyncSupervisorOptions): void {
  let identity: AuthIdentity | undefined;
  let running: AbortController | undefined;

  const restart = (next: AuthIdentity) => {
    if (signal.aborted || next === identity) {
      return; // same user as before, what is already running is still right
    }

    identity = next;
    running?.abort();
    running = new AbortController();

    const session = running.signal;
    const reachable = reachableTables(tables, next);

    void (async () => {
      // Clears out the previous user's rows before anything is downloaded for
      // this one. Reads the user the local data was last synced for from the
      // database, so it also catches a reload with somebody else signed in.
      await reconcileUser(pg, tables, next === EXTERNAL_AUTH ? EXTERNAL_USER : next);

      if (session.aborted) {
        return;
      }

      // Resolves when the session ends; each loop handles its own failures.
      void runOutgoingSync({
        pg,
        supabase,
        tables: reachable,
        signal: session,
        ...(onUnrecoverableError ? { onUnrecoverableError } : {}),
        ...(onError ? { onError } : {}),
      });

      await runIncomingSync({
        pg,
        supabase,
        tables: reachable,
        signal: session,
        ...(onError ? { onError } : {}),
      });
    })();
  };

  const stopWatching = watchAuthIdentity(supabase, restart);

  signal.addEventListener(
    'abort',
    () => {
      stopWatching();
      running?.abort();
    },
    { once: true },
  );
}

/**
 * Shape of the {@link supapower} extension.
 *
 * Narrower than PGlite's own `Extension` type on purpose: declaring
 * `namespaceObj` as required lets `PGliteInterfaceExtensions` infer
 * `pg.supapower` as `SupapowerNamespace` rather than `SupapowerNamespace |
 * undefined`.
 */
export interface SupapowerExtension {
  name: string;
  setup: (pg: PGliteInterface) => Promise<{ namespaceObj: SupapowerNamespace }>;
}

/**
 * Builds the `pg.supapower` namespace for a database.
 *
 * Exported on its own so Supapower can be used without registering it as a
 * PGlite extension - `createSupapower(pg).sync(...)` is the same code path as
 * `pg.supapower.sync(...)`.
 */
export function createSupapower(pg: PGliteInterface): SupapowerNamespace {
  return {
    async sync({
      supabase,
      tables,
      signal,
      scope = 'default',
      onUnrecoverableError,
      onError,
    }: SupapowerSyncOptions): Promise<SupapowerSync> {
      const leadership = createLeadership(pg, scope);
      const configs = resolveTables(tables);

      let stopLeadership: (() => void) | undefined;
      let stopped = false;

      const unsubscribe = () => {
        if (stopped) {
          return;
        }

        stopped = true;
        signal?.removeEventListener('abort', unsubscribe);
        stopLeadership?.();
        stopLeadership = undefined;
      };

      const handle: SupapowerSync = { leadership: leadership.strategy, unsubscribe };

      if (signal?.aborted) {
        stopped = true;

        return handle;
      }

      signal?.addEventListener('abort', unsubscribe, { once: true });

      // The schema has to exist in every tab, not just the one that ends up
      // leading: a tab that only writes still needs the change triggers in
      // place. Every statement is idempotent, and PGlite serializes them
      // through its single connection, so the redundant runs are harmless.
      await pg.waitReady;
      await runMigrations(pg);
      await trackTables(pg, [...configs.values()]);

      if (stopped) {
        return handle; // unsubscribed while the schema was being set up
      }

      stopLeadership = leadership.subscribe((leaderSignal) => {
        // Both directions run on the leader only: every tab shares one
        // database, so a second syncer would otherwise duplicate every write.
        superviseSync({
          pg,
          supabase,
          tables: configs,
          signal: leaderSignal,
          ...(onUnrecoverableError ? { onUnrecoverableError } : {}),
          ...(onError ? { onError } : {}),
        });
      });

      return handle;
    },
  };
}

/**
 * The Supapower PGlite extension, exposing {@link SupapowerNamespace} as
 * `pg.supapower`.
 *
 * ```ts
 * const pg = await PGliteWorker.create(worker, { extensions: { supapower } });
 * const sync = await pg.supapower.sync({ supabase, tables: ['todos'] });
 * ```
 *
 * Register it on the client side - in the tab - and not inside the worker's
 * `init()`. `PGliteWorker` strips `extensions` before forwarding the options to
 * the worker, so a copy registered there would be a second, separate namespace
 * that knows nothing about leader election.
 *
 * `setup` only builds the namespace; nothing touches the database until
 * {@link SupapowerNamespace.sync} is called. That is deliberate: on the client
 * side of a worker, PGlite runs extension setup before the database connection
 * exists, so any query issued from there would deadlock.
 */
export const supapower: SupapowerExtension = {
  name: 'Supapower',
  setup: async (pg: PGliteInterface) => ({ namespaceObj: createSupapower(pg) }),
};
