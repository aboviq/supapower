import type { PGliteInterface } from '@electric-sql/pglite';

import { createLeadership } from './leadership.js';
import { runMigrations, trackTables } from './migrations.js';
import { resolveTables, runOutgoingSync } from './sync.js';
import type { SupapowerNamespace, SupapowerSync, SupapowerSyncOptions } from './types.js';

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
        // Resolves when leadership is lost; the loop handles its own failures.
        void runOutgoingSync({
          pg,
          supabase,
          tables: configs,
          signal: leaderSignal,
          ...(onUnrecoverableError ? { onUnrecoverableError } : {}),
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
