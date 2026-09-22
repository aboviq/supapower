import { extensions } from '@supapower/vue';
import { createPGliteWorker } from '@supapower/worker';

// Both extensions belong on this side: the worker client strips `extensions`
// before forwarding the options, and `live` has to run in the tab for
// `useLiveQuery` to see it.
export const pg = await createPGliteWorker(
  {
    shared: () =>
      new SharedWorker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' }),
    fallback: () => new Worker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' }),
  },
  { id: 'supapower-vue-chat', extensions },
);

console.log('[supapower]', 'Transport', pg.transport);
