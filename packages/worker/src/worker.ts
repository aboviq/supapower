import type { WorkerOptions } from '@electric-sql/pglite/worker';

/**
 * The one worker entry point for `@supapower/worker`.
 *
 * Runs as a `SharedWorker` when the script is loaded as one - PGlite's own
 * `worker()` calls the global `postMessage`, which does not exist in a
 * SharedWorker scope, so the branch below is required, not cosmetic - and
 * falls back to PGlite's own dedicated worker otherwise.
 */
export async function worker(options: WorkerOptions): Promise<void> {
  if ('SharedWorkerGlobalScope' in globalThis) {
    // Dynamic: `./shared-worker.js` touches `BroadcastChannel`/`navigator.locks`
    // at import time in some bundlers' eager-eval mode, so it must load lazily
    // to keep this module importable from Node/Bun outside a worker.
    const { sharedWorker } = await import('./shared-worker.js');

    sharedWorker(options);

    return;
  }

  // Dynamic for the same reason: PGlite's dedicated-worker entry point pulls
  // in browser-only worker plumbing that must not run outside a worker scope.
  const { worker: dedicatedWorker } = await import('@electric-sql/pglite/worker');

  await dedicatedWorker(options);
}
