import type { PGliteInterface } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createLeadership } from './leadership.js';
import { runMigrations, trackTables } from './migrations.js';
import {
  type ResolvedTableConfig,
  resolveTables,
  runIncomingSync,
  runOutgoingSync,
} from './sync.js';
import type { SupapowerNamespace, SupapowerSync, SupapowerSyncOptions } from './types.js';

/** Stands in for a client whose token the application owns. */
const EXTERNAL_AUTH = Symbol('external-auth');

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

interface IncomingSupervisorOptions {
  pg: PGliteInterface;
  supabase: SupabaseClient;
  tables: Map<string, ResolvedTableConfig>;
  /** Aborted when leadership is lost or the sync is unsubscribed. */
  signal: AbortSignal;
}

/**
 * Keeps an incoming subscription open for whichever tables the current user can
 * actually see.
 *
 * Tables marked `anon` are subscribed to at all times; the ones left on the
 * default `authenticated` only while somebody is signed in. Because that set
 * changes when the user does, the subscription is torn down and rebuilt on
 * every identity change - a channel cannot have bindings added to it after it
 * has been subscribed.
 */
function superviseIncomingSync({ pg, supabase, tables, signal }: IncomingSupervisorOptions): void {
  const anonymous = new Map([...tables].filter(([, config]) => config.access === 'anon'));

  let identity: AuthIdentity | undefined;
  let running: AbortController | undefined;

  const restart = (next: AuthIdentity) => {
    if (signal.aborted || next === identity) {
      return; // same user as before, the open channel is still the right one
    }

    identity = next;
    running?.abort();
    running = new AbortController();

    void runIncomingSync({
      pg,
      supabase,
      tables: next === null ? anonymous : tables,
      signal: running.signal,
    });
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
      await trackTables(pg, [...configs.keys()]);

      if (stopped) {
        return handle; // unsubscribed while the schema was being set up
      }

      stopLeadership = leadership.subscribe((leaderSignal) => {
        // Both directions run on the leader only: every tab shares one
        // database, so a second syncer would otherwise duplicate every write.

        // Resolves when leadership is lost; the loop handles its own failures.
        void runOutgoingSync({
          pg,
          supabase,
          tables: configs,
          signal: leaderSignal,
          ...(onUnrecoverableError ? { onUnrecoverableError } : {}),
        });

        superviseIncomingSync({ pg, supabase, tables: configs, signal: leaderSignal });
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
