import { PGliteWorker } from '@electric-sql/pglite/worker';

import { extensions } from '@supapower/vue';

// Both extensions belong on this side: `PGliteWorker` strips `extensions`
// before forwarding the options to the worker, and `live` has to run in the
// tab for `useLiveQuery` to see it.
export const pg = await PGliteWorker.create(
  new Worker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' }),
  { extensions },
);
