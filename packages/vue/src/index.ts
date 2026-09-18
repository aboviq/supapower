import { makePGliteDependencyInjector } from '@electric-sql/pglite-vue';
import { live, type PGliteWithLive } from '@electric-sql/pglite/live';
import { supapower, type SupapowerExtension } from 'supapower';
import type { PGliteWithSupapower, SupapowerStatus } from 'supapower/types';
import {
  onScopeDispose,
  readonly,
  shallowReactive,
  toRefs,
  type DeepReadonly,
  type Ref,
  type ToRefs,
} from 'vue';

export * from '@electric-sql/pglite-vue';
export type { SupapowerStatus } from 'supapower/types';

/** A PGlite instance with both extensions this package needs. */
export type PGliteWithLiveAndSupapower = PGliteWithLive & PGliteWithSupapower;

/**
 * Both PGlite extensions a Supapower Vue app needs.
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

// pglite-vue's injection key is a module-level symbol shared by the default `providePGlite`,
// `injectPGlite` and every injector this returns, so these stay interoperable with `useLiveQuery`.
const injector = makePGliteDependencyInjector<PGliteWithLiveAndSupapower>();

/**
 * pglite-vue's `providePGlite`, typed for a database with the Supapower extension.
 *
 * Call it in a parent component's `setup`, not `app.provide` - the injection key is private to
 * pglite-vue.
 */
export const providePGlite: (
  db: PGliteWithLiveAndSupapower | Ref<PGliteWithLiveAndSupapower | undefined> | undefined,
) => void = injector.providePGlite;

/** The database from the nearest {@link providePGlite}, or `undefined` when there is none. */
export const injectPGlite: () => PGliteWithLiveAndSupapower | undefined = injector.injectPGlite;

/**
 * The current sync status as refs, kept up to date as it changes.
 *
 * Reads `pg.supapower.status` and subscribes to the `statusChange` event, so it is correct no
 * matter when the component mounts relative to `sync()`.
 *
 * ```vue
 * <script setup lang="ts">
 * const { connected, connecting, hasSynced, downloadError } = useSupapowerStatus();
 * </script>
 * ```
 */
export function useSupapowerStatus(
  db?: PGliteWithLiveAndSupapower,
): ToRefs<DeepReadonly<SupapowerStatus>> {
  const pg = db ?? injectPGlite();

  if (!pg) {
    throw new Error(
      'useSupapowerStatus(): no PGlite instance - call providePGlite(pg) in a parent component, or pass the database in',
    );
  }

  const { events } = pg.supapower;
  // `pg.supapower.status` is a new frozen object on every change; this is the reactive mirror of it.
  const status = shallowReactive({ ...pg.supapower.status });

  const onStatusChange = () => {
    Object.assign(status, pg.supapower.status);
  };

  events.addEventListener('statusChange', onStatusChange);
  onScopeDispose(() => {
    events.removeEventListener('statusChange', onStatusChange);
  });

  return toRefs(readonly(status));
}
