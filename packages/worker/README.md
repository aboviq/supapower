# `@supapower/worker`

A more stable drop-in replacement for PGlite's built-in
[multi-tab worker](https://pglite.dev/docs/multi-tab-worker): one `SharedWorker` hosts the
[PGlite](https://pglite.dev/) database for every tab, so the database is never owned by a particular
tab and never has to be handed over when one closes, with PGlite's own dedicated-worker setup as an
automatic fallback for browsers without `SharedWorker` (or where it fails to start). Works with plain
PGlite - [Supapower](https://github.com/aboviq/supapower/tree/main/packages/supapower#readme) is not
required.

> **Status:** Below 1.0.0. The public API may still change.

## Installation

```bash
npm install @supapower/worker @electric-sql/pglite
```

`@electric-sql/pglite` is a peer dependency - install it alongside this package. The peer range is
`>=0.5.8 <0.6.0`: this package depends on PGlite's _internal_ worker handshake, which is only
guaranteed to stay compatible within a minor version.

(of course, you can use the package manager of your choice, e.g. `bun` or `pnpm`)

## Usage

### 1. Write the worker script

```ts
// ./pglite-worker.ts
import { worker } from '@supapower/worker/worker';
import { PGlite } from '@electric-sql/pglite';

worker({
  async init(options) {
    return await PGlite.create(options);
  },
});
```

`worker()` detects at runtime whether it is running as a `SharedWorker` or a dedicated `Worker` and
speaks the right protocol for each - the same script works for both, so there is only ever one
worker file to write.

### 2. Connect from the tab

```ts
// ./pglite.ts
import { createPGliteWorker } from '@supapower/worker';

export const pg = await createPGliteWorker(
  {
    shared: () =>
      new SharedWorker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' }),
    fallback: () => new Worker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' }),
  },
  { id: 'my-app' },
);

console.log('Transport:', pg.transport); // 'shared-worker' or 'worker'
```

`id` is **required**. It is the only value that makes both transports agree on one election lock and
one broadcast channel - `PGliteWorker`'s own default id is derived from _its own_ `import.meta.url`,
which differs between the shared and the fallback worker scripts and would otherwise let the two open
the same `dataDir` as if they were unrelated databases. Pick one stable id per database your app
opens.

The returned `pg` **is** a [`PGliteWorker`](https://pglite.dev/docs/multi-tab-worker) - every method,
extension and the `live` query API work exactly as documented there, and any code written against
PGlite's own multi-tab worker keeps working unchanged. `pg.transport` reports which side actually
won: `'shared-worker'` when the `SharedWorker` started within `sharedWorkerTimeout` (10 seconds by
default), `'worker'` otherwise.

### 3. (Optional) Sync with Supapower

Nothing above needs [Supapower](https://github.com/aboviq/supapower/tree/main/packages/supapower#readme) -
`pg` is a plain `PGliteWorker` and works with any PGlite extension. Apps that do use it wire it up the
same way as with PGlite's own worker:

```ts
import { extensions } from '@supapower/vue'; // or `@supapower/react`, or plain `supapower`

export const pg = await createPGliteWorker(
  { shared: () => new SharedWorker(/* … */), fallback: () => new Worker(/* … */) },
  { id: 'my-app', extensions },
);

const sync = await pg.supapower.sync({ supabase, tables: ['todos'] });
```

`extensions` goes on this, the client side, call - not inside the worker's `init()` - the same rule
as `PGliteWorker.create` itself, since `createPGliteWorker` strips `extensions` before forwarding the
rest of the options to the worker.

## What differs from PGlite's own multi-tab worker

- **One worker instance for every tab.** PGlite's dedicated-worker transport elects one _tab_ to host
  the database and hands it over when that tab closes. A `SharedWorker` is not owned by any tab, so
  there is nothing to hand over - it simply outlives every tab until the last one disconnects.
- **`pg.isLeader` is always `false` on the shared transport.** There is only ever one `SharedWorker`
  instance per database, so there is nothing to elect a leader among. Code that reads `isLeader` to
  decide who does work needs a different signal on this transport - Supapower's own outgoing-sync
  leadership already handles this by electing on tab visibility instead, see
  [Multi-tab behavior](https://github.com/aboviq/supapower/tree/main/packages/supapower#multi-tab-behavior)
  in its README.
- **Safari ignores the `SharedWorker` constructor's `name` option.** Separate two databases by using
  a different worker script URL and a different `id`, not by `name`.

## License

Apache-2.0
