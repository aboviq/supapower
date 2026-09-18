import type { PGliteInterface } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { UnrecoverableUploadError } from './changes.js';
import { asSupapowerError } from './errors.js';
import { createSupapowerEvents, SupapowerErrorEvent, type SupapowerEventTarget } from './events.js';
import { createLeadership } from './leadership.js';
import { readLocalColumns, runMigrations, trackTables } from './migrations.js';
import { trackStatus } from './status.js';
import {
  reconcileUser,
  resolveTables,
  runIncomingSync,
  runOutgoingSync,
  withLocalColumns,
} from './sync.js';
import type {
  SupapowerNamespace,
  SupapowerSync,
  SupapowerSyncOptions,
  SupapowerSyncedTable,
} from './types.js';

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
  tables: Map<string, SupapowerSyncedTable>;
  /** Aborted when leadership is lost or the sync is unsubscribed. */
  signal: AbortSignal;
  events: SupapowerEventTarget;
  onUnrecoverableError?: (context: UnrecoverableUploadError) => void | Promise<void>;
}

/** The tables that are reachable for a given identity. */
function reachableTables(
  tables: Map<string, SupapowerSyncedTable>,
  identity: AuthIdentity,
): Map<string, SupapowerSyncedTable> {
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
 *
 * @returns A promise that resolves once `signal` has aborted and every
 * session it started has finished tearing down.
 */
function superviseSync({
  pg,
  supabase,
  tables,
  signal,
  events,
  onUnrecoverableError,
}: SyncSupervisorOptions): Promise<void> {
  let identity: AuthIdentity | undefined;
  let running: AbortController | undefined;

  // Every session started so far. Each one is aborted before the next begins,
  // but leaving the realtime channel outlives that abort, so a session that has
  // already been replaced still has to be waited out.
  let sessions: Promise<void> = Promise.resolve();

  const restart = (next: AuthIdentity) => {
    if (signal.aborted || next === identity) {
      return; // same user as before, what is already running is still right
    }

    identity = next;
    running?.abort();
    running = new AbortController();

    const session = running.signal;
    const reachable = reachableTables(tables, next);

    const work = (async () => {
      // Clears out the previous user's rows before anything is downloaded for
      // this one. Reads the user the local data was last synced for from the
      // database, so it also catches a reload with somebody else signed in.
      await reconcileUser(pg, tables, next === EXTERNAL_AUTH ? EXTERNAL_USER : next);

      if (session.aborted) {
        return;
      }

      // Both resolve when the session ends; each loop handles its own failures.
      const outgoing = runOutgoingSync({
        pg,
        supabase,
        tables: reachable,
        signal: session,
        events,
        ...(onUnrecoverableError ? { onUnrecoverableError } : {}),
      });

      await Promise.all([
        outgoing,
        runIncomingSync({ pg, supabase, tables: reachable, signal: session, events }),
      ]);
    })().catch((error: unknown) => {
      // Reported, not thrown: this promise is what `unsubscribe()` hands back,
      // and a failed teardown must not turn into a rejected cleanup call.
      events.dispatchEvent(
        new SupapowerErrorEvent(
          asSupapowerError(error, 'Could not sync for the current user', 'apply_failed'),
        ),
      );
    });

    sessions = sessions.then(() => work);
  };

  const stopWatching = watchAuthIdentity(supabase, restart);

  return new Promise<void>((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        stopWatching();
        running?.abort();
        // Resolving with the chain adopts it: the promise settles once the
        // aborted session has finished leaving the channel behind.
        resolve(sessions);
      },
      { once: true },
    );
  });
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
  const events = createSupapowerEvents();
  const status = trackStatus(events);

  return {
    events,
    get status() {
      return status.current;
    },
    async sync({
      supabase,
      tables,
      signal,
      scope = 'default',
      onUnrecoverableError,
    }: SupapowerSyncOptions): Promise<SupapowerSync> {
      const leadership = createLeadership(pg, scope);

      let configs = new Map<string, SupapowerSyncedTable>();
      let stopLeadership: (() => void) | undefined;
      let stopped = false;

      // Resolves once every supervisor started so far has torn itself down. This is
      // what `unsubscribe()` returns; leadership can be handed back and forth, so
      // each turn as leader appends its own teardown.
      let draining: Promise<void> = Promise.resolve();

      const unsubscribe = async (): Promise<void> => {
        if (!stopped) {
          stopped = true;
          signal?.removeEventListener('abort', unsubscribe);
          stopLeadership?.();
          stopLeadership = undefined;
          status.stopped();
        }

        await draining;
      };

      const handle: SupapowerSync = { leadership: leadership.strategy, unsubscribe };

      if (signal?.aborted) {
        stopped = true;

        return handle;
      }

      status.syncing();
      signal?.addEventListener('abort', unsubscribe, { once: true });

      // The schema has to exist in every tab, not just the one that ends up
      // leading: a tab that only writes still needs the change triggers in
      // place. Every statement is idempotent, and PGlite serializes them
      // through its single connection, so the redundant runs are harmless.
      await pg.waitReady;
      await runMigrations(pg);

      const resolved = resolveTables(tables);

      // Described after the migrations, so a table the application creates in
      // the same startup is already there to be read.
      const columns = await readLocalColumns(pg, resolved);

      configs = withLocalColumns(resolved, columns);

      await trackTables(pg, [...configs.values()]);

      if (stopped) {
        return handle; // unsubscribed while the schema was being set up
      }

      stopLeadership = leadership.subscribe((leaderSignal) => {
        status.leading(true);
        leaderSignal.addEventListener('abort', () => status.leading(false), { once: true });

        // Both directions run on the leader only: every tab shares one
        // database, so a second syncer would otherwise duplicate every write.
        const supervisor = superviseSync({
          pg,
          supabase,
          tables: configs,
          signal: leaderSignal,
          events,
          ...(onUnrecoverableError ? { onUnrecoverableError } : {}),
        });

        draining = draining.then(() => supervisor);
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
