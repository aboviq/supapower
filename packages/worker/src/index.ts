import type { Extensions, PGliteInterfaceExtensions } from '@electric-sql/pglite';
import type { PGliteWorker, PGliteWorkerOptions } from '@electric-sql/pglite/worker';

import { connectWithFallback, type WorkerFactories, type WorkerTransport } from './connect.js';

export type { WorkerFactories, WorkerTransport } from './connect.js';

export interface SupapowerWorkerOptions<
  E extends Extensions = Extensions,
> extends PGliteWorkerOptions<E> {
  /** Required: groups every tab of this database across both transports. */
  id: string;
  /**
   * Milliseconds to wait for the SharedWorker handshake before falling back
   * to PGlite's dedicated worker.
   *
   * @default 10000
   */
  sharedWorkerTimeout?: number;
}

/** What {@link createPGliteWorker} resolves to. */
export type SupapowerWorker<O extends SupapowerWorkerOptions> = PGliteWorker
  & PGliteInterfaceExtensions<O['extensions']> & { readonly transport: WorkerTransport };

/**
 * Opens a multi-tab PGlite database over a `SharedWorker`, falling back to
 * PGlite's own dedicated-worker transport when the browser has no
 * `SharedWorker`, or the shared one fails to start in time.
 *
 * `id` is required: it is the only value that makes both transports agree on
 * one election lock and one broadcast channel. PGlite's own default id is
 * derived from *its own* `import.meta.url`, which differs between the shared
 * and the fallback worker scripts and would let the two open the same
 * `dataDir` as if they were unrelated databases.
 */
export async function createPGliteWorker<O extends SupapowerWorkerOptions>(
  workers: WorkerFactories,
  options: O,
): Promise<SupapowerWorker<O>> {
  // Dynamic: loading `@electric-sql/pglite/worker`'s runtime code is deferred
  // to the call, not module scope, so this module stays importable under
  // Node/Bun (SSR, `bun test`) without pulling in browser worker plumbing.
  // Hoisted ahead of `connectWithFallback` so the `connect` callback below,
  // which is invoked synchronously inside it, already has `PGliteWorker`.
  const { PGliteWorker: PGliteWorkerClass } = await import('@electric-sql/pglite/worker');

  const { transport, db } = await connectWithFallback(
    workers,
    (worker) => PGliteWorkerClass.create(worker, options),
    options.sharedWorkerTimeout ?? 10_000,
  );

  Object.defineProperty(db, 'transport', { value: transport, enumerable: true });

  return db as SupapowerWorker<O>;
}
