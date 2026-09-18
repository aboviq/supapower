import {
  PGliteProvider as basePGliteProvider,
  usePGlite as baseUsePGlite,
  type PGliteProvider as PGliteProviderComponent,
} from '@electric-sql/pglite-react';
import { live, type PGliteWithLive } from '@electric-sql/pglite/live';
import { useCallback, useSyncExternalStore } from 'react';
import { supapower, type SupapowerExtension } from 'supapower';
import type { PGliteWithSupapower, SupapowerStatus } from 'supapower/types';

export * from '@electric-sql/pglite-react';
export type { SupapowerStatus } from 'supapower/types';

/** A PGlite instance with both extensions this package needs. */
export type PGliteWithLiveAndSupapower = PGliteWithLive & PGliteWithSupapower;

/**
 * Both PGlite extensions a Supapower React app needs.
 *
 * ```ts
 * const pg = await PGlite.create({ extensions });
 * // or, with the multi-tab worker - both go on the client side:
 * const pg = await PGliteWorker.create(worker, { extensions });
 * ```
 */
export const extensions: { live: typeof live; supapower: SupapowerExtension } = {
  live,
  supapower,
};

/**
 * pglite-react's provider, typed for a database with the Supapower extension.
 *
 * The same component, and therefore the same React context `useLiveQuery` reads
 */
export const PGliteProvider: PGliteProviderComponent<PGliteWithLiveAndSupapower> =
  basePGliteProvider;

/** The database from the nearest {@link PGliteProvider}, or `db` when given one. */
export function usePGlite(db?: PGliteWithLiveAndSupapower): PGliteWithLiveAndSupapower {
  // `PGliteProvider` only accepts a database carrying both extensions; pglite-react's
  // own type stops at `live`.
  return baseUsePGlite(db) as PGliteWithLiveAndSupapower;
}

/**
 * The current sync status, re-rendering the component whenever it changes.
 *
 * Reads `pg.supapower.status` and subscribes to the `statusChange` event, so it is
 * correct no matter when the component mounts relative to `sync()`.
 *
 * ```tsx
 * const { connected, connecting, hasSynced, downloadError } = useSupapowerStatus();
 * ```
 */
export function useSupapowerStatus(db?: PGliteWithLiveAndSupapower): SupapowerStatus {
  const pg = usePGlite(db);
  const { events } = pg.supapower;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      events.addEventListener('statusChange', onStoreChange);

      return () => {
        events.removeEventListener('statusChange', onStoreChange);
      };
    },
    [events],
  );

  const getSnapshot = useCallback(() => pg.supapower.status, [pg]);

  // Third argument: the snapshot needs no DOM, so server rendering reads the same
  // value instead of throwing.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
