# `supapower`

![Supapower](../../assets/supapower.svg)

The core for [Supapower](https://github.com/aboviq/supapower), a sync engine that keeps a
local PGlite database in sync with Supabase inspired by PowerSync.

> **Status:** early groundwork. The public API is still taking shape and will change.

## How it works?

Supapower is using [Supabase's Data API and JavaScript client](https://supabase.com/docs/reference/javascript) for syncing outgoing changes to Supabase, i.e. syncing local PGlite table changes to remote tables in Supabase's PostgreSQL database.

The Data API is also used for initially syncing data.

After the initial sync the local PGlite tables are kept up to date via [Supabase's Realtime](https://supabase.com/docs/guides/realtime) engine.

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

When the database is set up the sync is started. An initial sync is performed once and then the `supapower.changes` table is periodically queried and synced using the provided `supabase` client.

A realtime channel subscription is also set up on the provided `supabase` client to track remote changes to the tracked tables.

#### Type signature

```ts
function supapower.sync(options: SupapowerSyncOptions): void;
```

#### Related types

##### `SupapowerSyncOptions` - The Supapower options

```ts
interface SupapowerSyncOptions {
  supabase: SupabaseClient;
  tables: Array<SupapowerTableConfig | string>;
  /**
   * An optional AbortSignal to cancel the synchronization process.
   */
  signal?: AbortSignal;
}
```

For tables provided as a `string`, they are expected to have a primary key column named `"id"`. To use another primary key column name, use the `{ table: string; primaryKey?: string }` notation.

The initial sync is performed in the specified order of the tables provided in the `tables` array.

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

**Table `access` configuration**

The `access` configuration for a table controls what happens when a user signs in or out from Supabase (via the [`supabase.auth` API](https://supabase.com/docs/guides/auth)).

- `authenticated` (default) - truncates the table on user sign in and sign out, i.e. it's expected to be user dependent and won't be synced at all if there is no authenticated user
- `anon` - never truncates the table and it's synced even when there's no authenticated user

**Example:**

```ts
pg.supapower.sync({
  supabase,
  tables: [
    'items', // tracks table "items" with primary key "id"
    { table: 'todos' }, // tracks table "todos" with primary key "id"
    { table: 'tags', primaryKey: 'tag_id' }, // tracks table "tags" with primary key "tag_id"
    { table: 'plans', access: 'anon' }, // tracks table "plans" and it will be synced even when a user hasn't signed in
  ],
});
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
