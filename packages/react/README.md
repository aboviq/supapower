# `@supapower/react`

React hooks for [Supapower](https://github.com/aboviq/supapower/tree/main/packages/supapower#readme):
every hook from [`@electric-sql/pglite-react`](https://pglite.dev/docs/framework-hooks#react), a
ready-made `extensions` object covering both PGlite extensions a Supapower app needs, and
`useSupapowerStatus()` - a PowerSync-like sync status that re-renders your component as it changes.

## Installation

```bash
npm install @supapower/react supapower @electric-sql/pglite @supabase/supabase-js react
```

`supapower`, `@electric-sql/pglite` and `react` are peer dependencies - install them alongside this
package. Do **not** install `@electric-sql/pglite-react` yourself: this package re-exports all of it,
and a second copy in your dependency tree means a second React context, so `PGliteProvider` from one
copy and `useLiveQuery` from the other would not see each other.

(of course, you can use the package manager of your choice, e.g. `bun` or `pnpm`)

## Usage

### 1. Set up PGlite with both extensions

Supapower needs the `supapower` extension for syncing and the `live` extension for live queries.
`@supapower/react` exports both as one `extensions` object:

```ts
// ./pglite.ts
import { PGlite } from '@electric-sql/pglite';
import { extensions } from '@supapower/react';

export const pg = await PGlite.create({ extensions });
```

In a browser with the [multi-tab worker](https://pglite.dev/docs/multi-tab-worker) setup, both
extensions go on the **client side** `PGliteWorker.create` call, not inside the worker's `init()` -
`PGliteWorker` strips `extensions` before forwarding options to the worker:

```ts
// ./pglite.ts
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { extensions } from '@supapower/react';

export const pg = await PGliteWorker.create(
  new Worker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' }),
  { extensions },
);
```

Need another extension too? Spread it in: `extensions: { ...extensions, vector }`.

### 2. Start the sync

```ts
import { pg } from './pglite.js';
import { supabase } from './supabase.js';

const sync = await pg.supapower.sync({ supabase, tables: ['todos'] });
```

See the [core README](https://github.com/aboviq/supapower/tree/main/packages/supapower#readme) for
table configuration, error handling and multi-tab behavior.

### 3. Wrap your app and query

```tsx
import { PGliteProvider, useLiveQuery } from '@supapower/react';
import { pg } from './pglite.js';

function Todos() {
  const results = useLiveQuery.sql`SELECT * FROM todos ORDER BY created_at ASC`;

  return (
    <ul>
      {results?.rows.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}

export function App() {
  return (
    <PGliteProvider db={pg}>
      <Todos />
    </PGliteProvider>
  );
}
```

`useLiveQuery`, `useLiveIncrementalQuery`, `usePGlite`, `PGliteProvider` and `makePGliteProvider` are
re-exported from `@electric-sql/pglite-react` unchanged - see its
[docs](https://pglite.dev/docs/framework-hooks#react) for the full API.

### 4. Show the sync status

```tsx
import { useSupapowerStatus } from '@supapower/react';

function SyncBadge() {
  const { connected, connecting, hasSynced, downloadError, uploadError } = useSupapowerStatus();
  const error = downloadError ?? uploadError;

  return (
    <span style={{ color: connected ? 'green' : 'orange' }}>
      {connected ? 'connected' : connecting ? 'connecting…' : hasSynced ? 'idle' : 'starting…'}
      {error ? ` · ${error.message}` : null}
    </span>
  );
}
```

| Field           | Type                          | Meaning                                                               |
| --------------- | ----------------------------- | --------------------------------------------------------------------- |
| `leading`       | `boolean`                     | This tab or process is the one running the sync                       |
| `connected`     | `boolean`                     | The realtime channel is subscribed and delivering changes             |
| `connecting`    | `boolean`                     | Leading and syncing, but not connected yet                            |
| `downloading`   | `boolean`                     | A download (initial or catch-up) is in progress                       |
| `uploading`     | `boolean`                     | A batch of local changes is uploading                                 |
| `hasSynced`     | `boolean`                     | At least one full download has finished since `sync()` was called     |
| `lastSyncedAt`  | `Date \| undefined`           | When the last full download finished                                  |
| `downloadError` | `SupapowerError \| undefined` | The last download-side failure, cleared by the next finished download |
| `uploadError`   | `SupapowerError \| undefined` | The last upload-side failure, cleared by the next finished upload     |

`useSupapowerStatus()` works no matter when your component mounts relative to `sync()` - it reads
`pg.supapower.status` and subscribes to `pg.supapower.events`'s `statusChange`, so a component that
mounts after the sync already started still gets the current snapshot on its first render.

Each tab's status is entirely local: only the leader tab downloads, uploads and holds the realtime
channel, so every field - `hasSynced` included - stays `false` on a follower tab, even though its
data keeps arriving through the shared database. Read `leading` before trusting the rest of the
status. See
[Multi-tab behavior](https://github.com/aboviq/supapower/tree/main/packages/supapower#multi-tab-behavior)
in the core README.

## Exports

Everything from `@electric-sql/pglite-react` (`useLiveQuery`, `useLiveIncrementalQuery`,
`makePGliteProvider`), plus:

| Export                       | What                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `extensions`                 | `{ live, supapower }`, ready to pass to `PGlite.create`/`PGliteWorker.create` |
| `PGliteProvider`             | pglite-react's `PGliteProvider`, typed for a database with both extensions    |
| `usePGlite`                  | pglite-react's `usePGlite`, typed for a database with both extensions         |
| `useSupapowerStatus(db?)`    | The sync status hook described above                                          |
| `PGliteWithLiveAndSupapower` | Type: a PGlite instance carrying both extensions                              |
| `SupapowerStatus`            | Type: the shape `useSupapowerStatus()` returns                                |

## License

Apache-2.0
