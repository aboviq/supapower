# `@supapower/vue`

Vue composables for [Supapower](https://github.com/aboviq/supapower/tree/main/packages/supapower#readme):
every hook from [`@electric-sql/pglite-vue`](https://pglite.dev/docs/framework-hooks#vue), a
ready-made `extensions` object covering both PGlite extensions a Supapower app needs, and
`useSupapowerStatus()` - a PowerSync-like sync status that stays up to date as it changes.

> **Status:** Below 1.0.0. The public API may still change.

## Installation

```bash
npm install @supapower/vue supapower @electric-sql/pglite @supabase/supabase-js vue
```

`supapower`, `@electric-sql/pglite` and `vue` are peer dependencies - install them alongside this
package. Do **not** install `@electric-sql/pglite-vue` yourself: this package re-exports all of it,
and a second copy in your dependency tree means a second injection key (pglite-vue provides the
database against a module-private `Symbol`), so `providePGlite` from one copy would be invisible to
`useLiveQuery` from the other.

(of course, you can use the package manager of your choice, e.g. `bun` or `pnpm`)

## Usage

### 1. Set up PGlite with both extensions

Supapower needs the `supapower` extension for syncing and the `live` extension for live queries.
`@supapower/vue` exports both as one `extensions` object:

```ts
// ./pglite.ts
import { PGlite } from '@electric-sql/pglite';
import { extensions } from '@supapower/vue';

export const pg = await PGlite.create({ extensions });
```

In a browser with the [multi-tab worker](https://pglite.dev/docs/multi-tab-worker) setup, both
extensions go on the **client side** `PGliteWorker.create` call, not inside the worker's `init()` -
`PGliteWorker` strips `extensions` before forwarding options to the worker:

```ts
// ./pglite.ts
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { extensions } from '@supapower/vue';

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

### 3. Provide the database and query

```vue
<!-- App.vue -->
<script setup lang="ts">
import { providePGlite } from '@supapower/vue';
import { pg } from './pglite.js';

providePGlite(pg);
</script>

<template>
  <Todos />
</template>
```

```vue
<!-- Todos.vue -->
<script setup lang="ts">
import { useLiveQuery } from '@supapower/vue';

const { rows } = useLiveQuery.sql`SELECT * FROM todos ORDER BY created_at ASC`;
</script>

<template>
  <ul>
    <li v-for="todo in rows" :key="todo.id">{{ todo.title }}</li>
  </ul>
</template>
```

`providePGlite` must run inside a component's `setup` (not `app.provide`), since the injection key
is private to `@electric-sql/pglite-vue`. Unlike the React hooks, `useLiveQuery` and
`useSupapowerStatus` here return Vue refs; templates unwrap them automatically, and `rows` starts
`undefined` until the first result arrives.

`useLiveQuery`, `useLiveIncrementalQuery`, `injectPGlite`, `providePGlite` and
`makePGliteDependencyInjector` are re-exported from `@electric-sql/pglite-vue` unchanged - see its
[docs](https://pglite.dev/docs/framework-hooks#vue) for the full API.

### 4. Show the sync status

```vue
<script setup lang="ts">
import { useSupapowerStatus } from '@supapower/vue';

const { connected, connecting, hasSynced, downloadError, uploadError } = useSupapowerStatus();
const error = downloadError.value ?? uploadError.value;
</script>

<template>
  <span :style="{ color: connected ? 'green' : 'orange' }">
    {{ connected ? 'connected' : connecting ? 'connecting…' : hasSynced ? 'idle' : 'starting…' }}
    <template v-if="error"> · {{ error.message }}</template>
  </span>
</template>
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

Everything from `@electric-sql/pglite-vue` (`useLiveQuery`, `useLiveIncrementalQuery`,
`makePGliteDependencyInjector`), plus:

| Export                       | What                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `extensions`                 | `{ live, supapower }`, ready to pass to `PGlite.create`/`PGliteWorker.create` |
| `providePGlite`              | pglite-vue's `providePGlite`, typed for a database with both extensions       |
| `injectPGlite`               | pglite-vue's `injectPGlite`, typed for a database with both extensions        |
| `useSupapowerStatus(db?)`    | The sync status composable described above                                    |
| `PGliteWithLiveAndSupapower` | Type: a PGlite instance carrying both extensions                              |
| `SupapowerStatus`            | Type: the shape `useSupapowerStatus()` returns                                |

## License

Apache-2.0
