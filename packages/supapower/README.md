# `supapower`

![Supapower](../../assets/supapower.svg)

The core for [Supapower](https://github.com/aboviq/supapower), a sync engine that keeps a
local PGlite database in sync with Supabase inspired by PowerSync.

> **Status:** early groundwork. The public API is still taking shape and will change.

## How it works?

Supapower is using [Supabase's Data API and JavaScript client](https://supabase.com/docs/reference/javascript) for syncing outgoing changes to Supabase, i.e. syncing local PGlite table changes to remote tables in Supabase's PostgreSQL database.

Local writes to tracked tables are recorded by statement triggers into a `supapower.changes` queue, one row per change, grouped by the transaction they were made in. The queue is drained in order, one local transaction at a time, but each change in a transaction is sent individually to Supabase as the API doesn't support transactions.

The Data API is also used for initially syncing data, and after the initial sync the local PGlite tables are kept up to date via [Supabase's Realtime](https://supabase.com/docs/guides/realtime) engine.

> [!IMPORTANT]
> For all tables you want to sync both the Data API and Realtime must be enabled.

> [!CAUTION]
> You really should enable [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) for all synced tables to avoid unwanted access.

## Installation

Supapower needs both `@supabase/supabase-js` and `@electric-sql/pglite` as peer dependencies, so install all three with:

```bash
npm install supapower @electric-sql/pglite @supabase/supabase-js
```

## Usage

### 1. Set up your Supabase client

Follow [Supabase's JavaScript Client Library install instructions](https://supabase.com/docs/reference/javascript/installing).

After you have set up your Supabase client, let's assume your client code looks something like this:

```ts
// ./supabase.ts
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient('https://xyzcompany.supabase.co', 'your-publishable-key');
```

### 2. Set up PGlite

Follow [PGlite's Multi-tab Worker setup instructions](https://pglite.dev/docs/multi-tab-worker) and use the IndexedDB VFS which is recommended at the moment.

This will give you two more files: `pglite-worker.ts` and `pglite.ts`:

```ts
// ./pglite-worker.ts
import { PGlite, IdbFs } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';

worker({
  async init() {
    const pg = new PGlite({
      fs: new IdbFs('your-app'),
      relaxedDurability: true,
    });

    // Preferable run any database migrations here...

    return pg;
  },
});
```

> [!NOTE]
> there are a few recommendations regarding how you create your database tables, see [database migrations](#database-migrations) below.

```ts
// ./pglite.ts
import { PGliteWorker } from '@electric-sql/pglite/worker';

export const pg = await PGliteWorker.create(
  new Worker(new URL('./pglite-worker.ts', import.meta.url), {
    type: 'module',
  }),
);
```

### 3. Add the Supapower extension to PGlite

Modify your PGlite client configuration to the following:

```diff
// ./pglite.ts
import { PGliteWorker } from '@electric-sql/pglite/worker';
+ import { supapower } from 'supapower';

export const pg = await PGliteWorker.create(
  new Worker(new URL('./pglite-worker.ts', import.meta.url), {
    type: 'module',
  }),
+ {
+   extensions: {
+     supapower,
+   },
+ },
);
```

### 4. Start the synchronization with Supabase

```ts
import { pg } from './pglite.js';
import { supabase } from './supabase.js';

const sync = await pg.supapower.sync({
  supabase,
  tables: ['todos', 'lists'],
});

// And to stop the synchronization:
sync.unsubscribe();
```

### 5. Execute queries and profit

To really see the full sync loop in action you can use the [Live Queries](https://pglite.dev/docs/live-queries) extension for PGlite and open your app in two browsers or add rows using Supabase Studio.

When you have set up the `live` extension with PGlite, you can execute live queries to see real-time updates in your application.

Execute a live query:

```ts
await pg.live.query({
  query: 'SELECT * FROM todos',
  callback: (result) => {
    console.log(result.rows);
  },
});
```

Add a row to the `todos` table to see the live query result being logged to the console:

```ts
await pg.sql`INSERT INTO todos (title) VALUES (${'Test Supapower'})`;
```

Do the same from a different browser or from Supabase Studio and notice the live query result updating in the console.

**There you have it!**

## API

Supapower is a PGlite extension that extends the PGlite instance with a `supapower` namespace.

See each section below for the API specification of each method (or property) in the `supapower` namespace.

### `supapower.sync`

The main method of the namespace which both initiates the local PGlite database and starts the synchronization with Supabase.

Creates a `supapower` schema in the database with a generic `supapower.changes` table that will contain all unsynced outgoing local changes to tracked tables.

For each tracked table a statement trigger is attached for `INSERT`, `UPDATE` and `DELETE` operations that adds a row to sync to the `supapower.changes` table.

When the database is set up the sync is started. The outgoing queue is drained one local transaction at a time using the provided `supabase` client, and the loop is woken by a `NOTIFY` from the change trigger rather than by polling.

A realtime channel subscription is also set up on the provided `supabase` client to track remote changes to the tracked tables. Incoming changes are applied in the order they were broadcast, with the change triggers suppressed so an incoming change is not queued straight back up as an outgoing one.

Call it in **every** tab. The schema has to exist wherever writes happen, and the tab in charge of draining the queue may change at any time - see [Multi-tab behavior](#multi-tab-behavior) below.

#### Type signature

```ts
function supapower.sync(options: SupapowerSyncOptions): Promise<SupapowerSync>;
```

The returned promise resolves once the schema is in place and the sync has been started, not once anything has been synced.

#### Related types

##### `SupapowerSyncOptions` - The Supapower options

```ts
interface SupapowerSyncOptions {
  supabase: SupabaseClient;
  tables: Array<SupapowerTableConfig | string>;
  /**
   * An optional AbortSignal to cancel the synchronization process.
   *
   * Aborting it is equivalent to calling `unsubscribe()`.
   */
  signal?: AbortSignal;
  /**
   * Scopes the cross-tab lock that keeps a single tab in charge of the queue.
   *
   * Only used for a plain `PGlite` instance - see "Multi-tab behavior".
   *
   * @default "default"
   */
  scope?: string;
  /**
   * Decides what happens to a batch Supabase rejects for good.
   *
   * @default Discards the batch.
   */
  onUnrecoverableError?: (context: UnrecoverableUploadError) => void | Promise<void>;
}
```

For tables provided as a `string`, they are expected to have a primary key column named `"id"`. To use another primary key column name, use the `{ table: string; primaryKey?: string }` notation.

The initial sync is performed in the specified order of the tables provided in the `tables` array.

##### `SupapowerSync` - The sync handle

```ts
interface SupapowerSync {
  /**
   * How the single active syncer is elected across tabs and processes.
   */
  readonly leadership: 'worker-leader' | 'web-lock' | 'single-process';
  /**
   * Stops the synchronization process. Local changes are still
   * tracked. Safe to call more than once.
   */
  unsubscribe(): void;
}
```

##### `SupapowerTableConfig` - Tracked tables configuration

```ts
interface SupapowerTableConfig {
  table: string;
  /**
   * @default "id"
   */
  primaryKey?: string;
  /**
   * @default "authenticated"
   */
  access?: 'anon' | 'authenticated';
}
```

###### Table `access` configuration

The `access` configuration for a table controls what happens when a user signs in or out from Supabase (via the [`supabase.auth` API](https://supabase.com/docs/guides/auth)).

- `authenticated` (default) - truncates the table on user sign in and sign out, i.e. it's expected to be user dependent and won't be synced at all if there is no authenticated user
- `anon` - never truncates the table and it's synced even when there's no authenticated user

The realtime subscription follows this setting: `anon` tables are subscribed to at all times, the rest only while somebody is signed in. It is rebuilt when the signed in user changes, and deliberately left alone when only the access token was refreshed - supabase-js pushes a refreshed token onto the realtime socket by itself, so re-subscribing would drop messages for nothing.

A client created with the [`accessToken` option](https://supabase.com/docs/reference/javascript/initializing) owns its own token and has no auth state to follow, so all of its tables are treated as reachable.

> [!NOTE]
> The truncation is not implemented yet. Signing out narrows the realtime subscription, but rows the previous user could see stay in the local database.

**Example:**

```ts
await pg.supapower.sync({
  supabase,
  tables: [
    'items', // tracks table "items" with primary key "id"
    { table: 'todos' }, // tracks table "todos" with primary key "id"
    { table: 'tags', primaryKey: 'tag_id' }, // tracks table "tags" with primary key "tag_id"
    { table: 'plans', access: 'anon' }, // tracks table "plans" and it will be synced even when a user hasn't signed in
  ],
});
```

### Multi-tab behavior

Every tab that opens the same PGlite database shares one set of files, and therefore one
`supapower.changes` queue. Exactly one tab may drain it, otherwise the same batch is pushed twice.

That lock cannot live in Postgres. PGlite is a single-connection engine and every tab runs its own
instance, so `pg_advisory_lock()` is invisible to the other tabs and would block the only connection
this one has. Supapower coordinates in the browser instead, and picks the strongest mechanism the
runtime offers:

| `leadership`     | When                                   | Mechanism                                                                                                                  |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `worker-leader`  | The database is a `PGliteWorker`       | PGlite's own leader election - the tab that hosts the database                                                             |
| `web-lock`       | A plain `PGlite` instance in a browser | An exclusive [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) named `supapower:outgoing:<scope>` |
| `single-process` | Node, Bun, Deno                        | None - a second process is assumed not to exist                                                                            |

Leadership is handed over on its own: a Web Lock is released by the browser when the tab closes or
crashes, and `PGliteWorker` re-runs its election. The waiting tab takes over and resumes draining
where the previous one left off. Read `sync.leadership` to see which mechanism you ended up with.

> [!IMPORTANT]
> Use the [multi-tab worker](https://pglite.dev/docs/multi-tab-worker) as shown in [step 2](#2-set-up-pglite).
> Opening a plain `PGlite` instance against the same `dataDir` from several tabs risks corrupting the
> database no matter what Supapower does with the queue, the `web-lock` strategy only keeps two tabs from
> pushing the same changes.

### Error handling

A failed upload is one of two things, and Supapower treats them differently.

**Transient** - offline, a 5xx, a dropped connection. The batch stays queued and is retried with an
exponential backoff, from 1 second up to a minute.

**Unrecoverable** - a data type mismatch (Postgres class `22`), an integrity constraint violation
(class `23`) or a row-level security denial (`42501`). Supabase will reject these the same way every
time, and because the queue is strictly ordered the batch would block every later change behind it
forever. By default Supapower discards the whole batch to keep the queue moving.

Override that with `onUnrecoverableError` when losing the data is not acceptable:

```ts
import type { UnrecoverableUploadError } from 'supapower/changes';

const sync = await pg.supapower.sync({
  supabase,
  tables: ['todos'],
  onUnrecoverableError: async ({ error, batch, change, commit }) => {
    await reportToSentry(error, { change });
    await saveForLater(batch);
    await commit(); // drops the batch from the queue
  },
});
```

```ts
interface UnrecoverableUploadError {
  /** The error Supabase returned, as the cause of a `SupapowerUploadError`. */
  readonly error: unknown;
  /** Every change in the local transaction that failed, in order. */
  readonly batch: Readonly<ChangeRow[]>;
  /** The change that was rejected. */
  readonly change: ChangeRow;
  /** Drops the whole batch from the outgoing queue. */
  readonly commit: () => Promise<void>;
}
```

Returning without calling `commit()` leaves the batch queued, and the sync retries it after a
backoff - use that to park a batch rather than lose it, but expect the callback to fire again.

> [!CAUTION]
> Discarding is not a rollback. The changes **before** the rejected one in the batch are already
> upstream, so dropping the batch leaves that transaction half applied in Supabase with nothing
> locally to say so. Treat `onUnrecoverableError` as the last chance to notice a divergence.

Uploads are idempotent by design - `upsert` on the primary key, `delete` by primary key - because a
crash between the upload and the queue delete leaves the batch queued for the next leader to send
again.

### Entry points

Everything needed for the common case is on the package root. The rest is split per module so that
go-to-definition lands on the definition rather than on a re-export.

| Import                 | Contains                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `supapower`            | `supapower` (the extension), `createSupapower`                                         |
| `supapower/types`      | `SupapowerSyncOptions`, `SupapowerSync`, `SupapowerTableConfig`, `PGliteWithSupapower` |
| `supapower/changes`    | `ChangeRow`, `UnrecoverableUploadError`, `SyncTransaction`                             |
| `supapower/errors`     | `SupapowerError`, `SupapowerUploadError`, `isUnrecoverableUploadError`                 |
| `supapower/leadership` | `createLeadership` and the individual strategies                                       |

`createSupapower(pg)` is the same code path as the extension, for when registering an extension is
not an option:

```ts
import { createSupapower } from 'supapower';

const sync = await createSupapower(pg).sync({ supabase, tables: ['todos'] });
```

## Database migrations

As Supapower uses PGlite, which is a PostgreSQL database, you could easily copy your database migration queries from Supabase to the client and it will work, but it's not recommended without slightly modifying them.

The key difference with client databases and backend databases is that you'll eventually end up with many different versions of the client application. Either because of caches, or because users doesn't always immediately update their app when a new version is available.

This places higher demands on backward and forward compatibility and there are some tricks below you can use to ease maintenance and avoiding database errors.

### Schema recommendations

Here are some recommendations when writing your migrations to make the most out of Supapower and to avoid any schema or data issues.

Recommendations are for either the client (<kbd>C</kbd>) or the server (<kbd>S</kbd>) or both.

- <kbd>C</kbd> make all columns nullable, except the primary key
  - if you're really sure some other columns will never ever be missing in the future (like `created_at`) you can keep them non-nullable as well
- <kbd>C</kbd> remove all foreign key constraints
  - keep the columns, but remove the constraints as we don't know in which order rows will be synced
- <kbd>C</kbd><kbd>S</kbd> prefer soft deletes over `DELETE` queries, i.e. use a `deleted_at` column or similar and filter all queries with it
  - this recommendation is for the Supabase migrations as well because realtime events for deleted rows are not sent by default (see [Delete events limitation](https://supabase.com/docs/guides/realtime/postgres-changes#delete-events))
  - even if delete events are received via the realtime engine they will only sync to online users, this means that rows deleted by other users while you are offline will still be in your client's database
- <kbd>C</kbd><kbd>S</kbd> use uuid's as primary keys
  - as the primary key is shared between the client and server databases and can be created at any end they shouldn't be able to collide, which is why a sequence number won't work
- <kbd>C</kbd><kbd>S</kbd> have a single primary key in every table that you want to sync
  - support for compound primary keys in Supapower has not been implemented yet
  - from my experience even when you want compound primary keys it's usually better to have a single PK with a unique key for the compound keys instead

Conclusion: relax your client database schema, use soft deletes and always use single primary keys as `uuid` columns.

## License

[Apache-2.0](LICENSE), Copyright 2026 Aboviq AB.
