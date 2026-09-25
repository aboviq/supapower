<picture>
  <source srcset="https://raw.githubusercontent.com/aboviq/supapower/main/assets/supapower-dark.png" media="(prefers-color-scheme: dark)">
  <source srcset="https://raw.githubusercontent.com/aboviq/supapower/main/assets/supapower-light.png" media="(prefers-color-scheme: light)">
  <img src="https://raw.githubusercontent.com/aboviq/supapower/main/assets/supapower-fallback.png" alt="Supapower - With Supapower comes great sync abilities">
</picture>

# `supapower`

The core for [Supapower](https://github.com/aboviq/supapower), a sync engine that keeps a
local PGlite database in sync with Supabase inspired by PowerSync.

> **Status:** Below 1.0.0. Both directions of the sync work; the public API may still change.

## Why Supapower

- **Nothing new to deploy** - Supabase's Data API and Realtime _are_ the sync protocol; no sync
  service, no replication slot, no second bill.
- **Real Postgres on both ends** - the client is PGlite, not SQLite: the same SQL, the same
  types, and migrations you can lift from the server.
- **Your RLS policies are the sync rules** - downloads and writes go through PostgREST as the
  signed-in user, so there is no second authorization language to keep in step.
- **Two-way sync that merges per column** - offline writes queue per transaction and upload only
  the columns that changed, so two people editing different fields of a row both keep their edit.
- **Three lines to adopt** - a PGlite extension plus one `sync()` call; no codegen, no schema DSL,
  no client-side query language to learn.
- **Small, permissive, batteries included** - Apache-2.0 with zero runtime dependencies, plus a
  `SharedWorker` multi-tab host, React and Vue bindings, and a typed status and event API.

Longer version, and how it compares with RxDB, PowerSync, Electric and Zero:
[supapower.dev/why-supapower](https://supapower.dev/why-supapower/) ·
[supapower.dev/comparison](https://supapower.dev/comparison/)

## How it works?

Supapower is using [Supabase's Data API and JavaScript client](https://supabase.com/docs/reference/javascript) for syncing outgoing changes to Supabase, i.e. syncing local PGlite table changes to remote tables in Supabase's PostgreSQL database.

Local writes to tracked tables are recorded by statement triggers into a `supapower.changes` queue, one row per change, grouped by the transaction they were made in. The queue is drained in order, one local transaction at a time, but each change in a transaction is sent individually to Supabase as the API doesn't support transactions.

The Data API is also used for initially syncing data, and after the initial sync the local PGlite tables are kept up to date via [Supabase's Realtime](https://supabase.com/docs/guides/realtime) engine.

> [!IMPORTANT]
> For all tables you want to sync both the Data API and [Realtime](https://supabase.com/docs/guides/realtime/postgres-changes) must be enabled.

> [!CAUTION]
> You really should enable [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) for all synced tables to avoid unwanted access.

## Installation

Supapower needs both `@supabase/supabase-js` and `@electric-sql/pglite` as peer dependencies, so install them and `supapower` with:

```bash
npm install supapower @electric-sql/pglite @supabase/supabase-js
```

(of course, you can use the package manager of your choice, e.g. `bun` or `pnpm`)

## Quick Start

### 1. Set up your Supabase client

Follow [Supabase's JavaScript Client Library install instructions](https://supabase.com/docs/reference/javascript/installing).

After you have set up your Supabase client, let's assume your client code looks something like this:

```ts
// ./supabase.ts
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient('https://xyzcompany.supabase.co', 'your-publishable-key');
```

### 2. Set up PGlite with the Supapower extension

```ts
// ./pglite.ts
import { PGlite } from '@electric-sql/pglite';
import { supapower } from 'supapower';

export const pg = await PGlite.create({
  extensions: { supapower },
});
```

This is the same call in a browser, Node.js, Bun or Deno - it's an in-memory database, so there's
nothing further to set up yet.

### 3. Start the synchronization with Supabase

Use the [`supapower.sync`](#supapowersync) method to initiate the database and start the synchronization with Supabase:

```ts
import { pg } from './pglite.js';
import { supabase } from './supabase.js';

const sync = await pg.supapower.sync({
  supabase,
  tables: ['todos', 'lists'],
});

// And if/when you need to stop the synchronization:
await sync.unsubscribe();
```

### 4. Execute queries and profit

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

> [!IMPORTANT]
> This in-memory database resets on every reload and isn't shared across tabs. Read
> [Persistent storage](#persistent-storage) below before you ship a real app.

> [!TIP]
> Checkout the [`example/`](https://github.com/aboviq/supapower/tree/main/example/) folder for complete runnable example apps.

## Persistent storage

The Quick Start above uses an in-memory database - nothing survives a reload. To keep data across
restarts, give PGlite a filesystem.

In Node.js, Bun or Deno:

```ts
import { NodeFS, PGlite } from '@electric-sql/pglite';
import { supapower } from 'supapower';

export const pg = await PGlite.create({
  fs: new NodeFS('./path/to/datadir/'),
  extensions: { supapower },
});
```

In a browser, do the same with `IdbFs` - but only from a worker, and never by opening a persistent
`PGlite` instance directly from more than one tab. PGlite is a single-connection engine, and two tabs
writing to the same files at once risks corrupting the database. See
[Multi-tab behavior](#multi-tab-behavior) below for the safe way to set that up.

## API

Supapower is a PGlite extension that extends the PGlite instance with a `supapower` namespace.

See each section below for the API specification of each method (or property) in the `supapower` namespace.

### `supapower.sync`

The main method of the namespace which both initiates the local PGlite database and starts the synchronization with Supabase.

- Creates a `supapower` schema in the local database
- Creates a generic `supapower.changes` table with a queue for unsynced outgoing local changes to tracked tables.
- Attaches statement triggers for `INSERT`, `UPDATE` and `DELETE` operations on each tracked table to add a row to the `supapower.changes` table.
- Creates a `supapower.metadata` table to store metadata about the synchronization process and current settings.
- Drains the outgoing queue one local transaction at a time using the provided `supabase` client.
- Sets up a realtime channel subscription on the provided `supabase` client to track remote changes to the tracked tables.
- Performs an initial download to bring the local tables up to date with the remote state (can be incremental using the [`cursor`](#table-cursor-configuration) option).
- Empties user dependent tables on user change or logout.
- Re-syncs all tracked tables whenever the user changes or logs back in to not miss any updates while offline.

Uses upserts for inserts and updates to ensure that the local database remains consistent with the remote state. See [Conflicts](#conflicts) for more details.

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
   * Aborting it is equivalent to calling `unsubscribe()`. An abort event
   * cannot be awaited, so call `unsubscribe()` as well when you need to know
   * the teardown has finished.
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
   * How long a table's last completed download stays fresh, in milliseconds.
   *
   * A table that finished downloading more recently than this is skipped
   * instead of being pulled again; `0` downloads every table every time. A
   * changed `cursor` or local column set bypasses this and downloads anyway.
   *
   * @default 60000
   */
  downloadThrottle?: number;
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

> [!NOTE]
> The initial sync asks only for the columns this client's schema has, upserts whole rows on the primary key - which makes re-running it harmless - and never deletes. A row hard deleted remotely while this client was away only disappears locally on the next truncation (e.g. on user change or sign out). Configure [`cursor`](#table-cursor-configuration) to make it ask for only what changed; without it, every start pulls the whole table - throttled to once per `downloadThrottle` (see above), so a changed `cursor` or local column set is the exception that always downloads again immediately.

##### Conflicts

A row can be edited in two places at once: locally, while a change is still waiting in the outgoing queue, and remotely by somebody else. Supapower resolves that **per column**.

An update sends only the columns it actually changed, worked out from the before and after state the change trigger recorded. So if you edit `title` offline while somebody else edits `done`, your upload sets `title` and leaves `done` as they left it. The merge happens in Postgres, and both edits survive.

Locally the rule is blunter, and only briefly: **while a row has an unsynced local change, an incoming change for it is not applied.** That is a delay rather than a loss. Your own upload comes back over realtime carrying the whole merged row - `postgres_changes` always sends the full record - and by then the queue is empty, so it is applied. The row converges on the version that has both edits.

What that leaves:

- **Two clients editing the same column still resolve last write wins.** The granularity is the column, not the edit. Supapower is not a CRDT and will not merge two people's text.
- **A delete beats a concurrent edit**, whatever columns it touched. There is nothing to merge into, and an edit that arrives after it matches no row.
- **An update that matches no row is dropped**, and reported as `update_ignored`. The row is gone upstream, or row-level security is hiding it; from here the two look identical. Your local copy keeps the edit, so use the callback to decide what should happen to it.
- **Converging needs a way back.** The round trip relies on the realtime echo, or failing that on [`cursor`](#table-cursor-configuration) picking the row up at the next start because your own upload moved its `updated_at`. A table with neither stays stale locally until it is downloaded whole again.

##### Schema drift

The client's schema is the application's, and it lags behind the remote one whenever the server deploys first.

Supapower does not treat that as an error:

- The download asks Supabase for the columns it knows by name, so a column it has never heard of is never sent.
- A realtime change that carries a column unknown to the client has it trimmed off before the row is written, and the column is reported once per session through [the `error` event](#supapowerevents) as `column_ignored`. The rest of the row is still applied.
- An old client never overwrites what it dropped. `upsert` only sets the columns it sends, so a row updated locally keeps the newer column's value upstream.

The value is therefore not lost, only not local yet. Once the application migration adds the column, the stored watermark no longer covers the columns being asked for, and that table is downloaded whole again to fill it in. The same happens if [`cursor`](#table-cursor-configuration) is pointed at a different column than before.

##### `SupapowerSync` - The sync handle

```ts
interface SupapowerSync {
  /**
   * How the single active syncer is elected across tabs and processes.
   */
  readonly leadership: 'visible-tab' | 'web-lock' | 'single-process';
  /**
   * Stops the synchronization process. Local changes are still tracked.
   * Resolves once the realtime channel has been left. Never rejects.
   * Safe to call more than once.
   */
  unsubscribe(): Promise<void>;
}
```

##### `SupapowerTableConfig` - Tracked tables configuration

```ts
interface SupapowerTableConfig {
  table: string;
  /**
   * Schema the table lives in remotely, in Supabase.
   *
   * @default "public"
   */
  schema?: string;
  /**
   * Schema the table lives in locally, in PGlite, when that differs.
   *
   * @default The table's remote `schema`
   */
  localSchema?: string;
  /**
   * @default "id"
   */
  primaryKey?: string;
  /**
   * Timestamp column that moves on every write, e.g. "updated_at".
   *
   * Given one, the download after the first only asks for what changed.
   */
  cursor?: string;
  /**
   * Determines the access level required to sync this table.
   *
   * - `"anon"` allows anonymous users to sync this table.
   * - `"authenticated"` requires the user to be signed in to sync this table.
   *
   * @default "authenticated"
   */
  access?: 'anon' | 'authenticated';
  /**
   * Narrows which rows this table syncs, applied to both the download and
   * the realtime subscription. Handed a fresh filter builder and the
   * current session, and must return the builder.
   */
  filter?: (filter: SupapowerFilter, session: Session | null) => SupapowerFilter;
}
```

###### Table `cursor` configuration

Without a `cursor` every start, or user change, downloads the whole table. Point it at a timestamp column that is set to the current time on every write (preferably using a trigger in the remote database) and the download after the first only asks for rows at or after (with a bit of margin, see below) the last value it saw:

```ts
{ table: 'todos', cursor: 'updated_at' }
```

Supabase has no built-in "give me everything since" - the Data API only queries the table as it stands, and Realtime never replays what you missed - so this column is what makes an incremental download possible at all.

Three things to know about it:

- **The download reaches a minute further back than the last value it saw.** A write stamps its timestamp with the transaction's start time but only becomes visible when it commits, so a slow transaction can land a row behind a watermark that has already moved past it. The margin covers transactions up to a minute; anything slower is missed until the table is downloaded whole again.
- **Hard `DELETE`s cannot be picked up this way.** The row is simply gone, so nothing comes back to say so. Use soft deletes, and read the [schema recommendations](#schema-recommendations) below.
- **A row that becomes visible without changing is invisible to it.** An incremental download asks for rows whose timestamp moved. Being added to a shared project does not move any timestamp on the project's rows - they were there all along, you just could not see them - so they are never fetched. Realtime does not help either: it only delivers rows that actually change. See the [schema recommendations](#schema-recommendations) below for what to do about it.
- **A full download will still happen in some cases:** the `cursor` is changed to another column, or the the local tracked table's schema changed, or the table [depends on the current user](#table-access-configuration) and it changed.

###### Table `schema` configuration

Everything defaults to `public` on both sides, and a table that stays there needs neither option.

`schema` moves a table to another schema in Supabase. Expose it in the project's [Data API settings](https://supabase.com/docs/guides/api/using-custom-schemas) and add its tables to the realtime publication, the same as you would for `public` - the Data API and Realtime both go to the schema named here, not to the client's own default:

```ts
{ table: 'todos', schema: 'app' }
```

That also expects `app.todos` locally. `localSchema` splits the two apart:

```ts
{ table: 'notes', schema: 'app', localSchema: 'mirror' }
```

Now `app.notes` in Supabase is kept in sync with `mirror.notes` in PGlite. Use it to keep synced tables out of the local `public` schema, or to flatten several remote schemas into one local one. Only the local side moves; the Data API request and the realtime binding still say `app`.

A few things follow from a table being identified by both halves:

- **A table is keyed by where it lives locally.** `public.todos` and `app.todos` are two different tables, tracked separately, with separate download watermarks - and a local change to one is never pushed as the other.
- **The change triggers record the schema they fired in**, so the outgoing queue only drains changes belonging to a configured table. Anything else waits, untouched.
- **Truncation on a user change follows `localSchema`.** The local table is emptied and its queued changes dropped, a same-named table in another schema is left alone.
- **Watermarks are keyed by the local name.** Moving a table between schemas means its next start downloads it whole.

###### Table `access` configuration

The `access` configuration for a table controls what happens when a user signs in or out from Supabase (via the [`supabase.auth` API](https://supabase.com/docs/guides/auth)).

- `authenticated` (default) - truncates the table on user sign in and sign out, i.e. it's expected to be user dependent and won't be synced at all if there is no authenticated user
- `anon` - never truncates the table and it's synced even when there's no authenticated user

The realtime subscription follows this setting: `anon` tables are subscribed to at all times, the rest only while somebody is signed in. It is rebuilt when the signed in user changes, and deliberately left alone when only the access token was refreshed - supabase-js pushes a refreshed token onto the realtime socket by itself, so no need to re-subscribe manually.

> [!NOTE]
> A client created with the [`accessToken` option](https://supabase.com/docs/reference/javascript/initializing) owns its own token and has no auth state to follow, so all of its tables are treated as reachable.

When the signed in user changes - in either direction - the `authenticated` tables are truncated before anything is downloaded for the new one, and the outgoing queue is cleared of their changes too.

> [!CAUTION]
> Unsynced local writes to `authenticated` tables are lost on sign out. They were made by the previous user and cannot be pushed upstream as the next one, so they go with the rows. Push what matters before signing out.

**Example:**

```ts
await pg.supapower.sync({
  supabase,
  tables: [
    'items', // tracks table "items" with primary key "id"
    { table: 'todos' }, // tracks table "todos" with primary key "id"
    { table: 'tags', primaryKey: 'tag_id' }, // tracks table "tags" with primary key "tag_id"
    { table: 'notes', cursor: 'updated_at' }, // only downloads what changed since last time
    { table: 'plans', access: 'anon' }, // tracks table "plans" and it will be synced even when a user hasn't signed in
    { table: 'docs', schema: 'app' }, // syncs "app.docs" in Supabase with "app.docs" locally
    { table: 'notes', schema: 'app', localSchema: 'mirror' }, // syncs "app.notes" in Supabase with "mirror.notes" locally
  ],
});
```

###### Table `filter` configuration

`filter` narrows which rows a table syncs. It is handed a fresh filter builder and the current
session, and must return the builder; the same filter narrows both the PostgREST download and the
`postgres_changes` subscription:

```ts
{
  table: 'todos',
  filter: (filter, session) => filter.eq('workspace_id', session?.user.app_metadata['workspace']),
}
```

A few boundaries follow from how it is applied:

- **Conditions are `AND`ed only.** No `OR`, no subqueries, no joins. A membership rule only fits as
  an `in` list, capped at 100 values by Realtime - see
  [Postgres Changes filters](https://supabase.com/docs/guides/realtime/postgres-changes#available-filters).
- **A filtered subscription only delivers `DELETE` events when the remote table's replica identity
  is `full`**, since the filter is evaluated against the old record - another reason for the soft
  deletes already recommended under [Schema recommendations](#schema-recommendations).
- **A changed resolved filter - typically because a claim in a refreshed token changed - truncates
  the local table and downloads it again.** A row still waiting in the outgoing queue is gone
  locally until its upload echoes back.
- **Nothing removes a row that stops matching the filter on its own.** Rows only ever arrive as
  upserts, and neither the download nor the subscription reports a row that no longer matches.
- **Local writes to rows outside the filter still upload** - row-level security decides, the filter
  does not.
- **A callback that throws stops that table syncing for that session** and reports `filter_failed`
  (an `in` with an empty list, for one). Use `is(column, null)` on a `NOT NULL` column to sync
  nothing on purpose.

### `supapower.events`

An `EventTarget`, typed for the events Supapower dispatches, so listeners can be attached with the
standard `addEventListener`/`removeEventListener` and more than one can watch the same event.

It exists as soon as `pg.supapower` does, so listeners can be attached before `sync()` is ever
called - nothing is dispatched until it is:

```ts
pg.supapower.events.addEventListener('downloadTableStart', (event) => {
  console.log(`downloading ${event.config.table}...`);
});

const sync = await pg.supapower.sync({ supabase, tables: ['todos'] });
```

| Event                 | Fires                                                                                  | Extra          |
| --------------------- | -------------------------------------------------------------------------------------- | -------------- |
| `downloadStart`       | An initial (or catch-up) download of every table has started                           |                |
| `downloadTableStart`  | A single table's download has started                                                  | `event.config` |
| `downloadTableFinish` | A single table's download has finished                                                 | `event.config` |
| `downloadFinish`      | An initial (or catch-up) download of every table has finished                          |                |
| `uploadStart`         | A batch of local changes has started uploading to Supabase                             |                |
| `uploadFinish`        | A batch of local changes has finished uploading to Supabase                            |                |
| `connect`             | The realtime channel is subscribed and delivering changes                              |                |
| `disconnect`          | The realtime channel stopped delivering changes                                        |                |
| `error`               | Something went wrong but did not stop the sync - see [Error handling](#error-handling) |                |
| `statusChange`        | The derived [`supapower.status`](#supapowerstatus) changed                             |                |

`downloadTableStart`/`downloadTableFinish` fire once per table on every download, initial or
catch-up alike; `downloadStart`/`downloadFinish` bracket the whole run. A download that fails
halfway - reported through `error` - stops short of dispatching a `finish` for the table it was on
or for the run as a whole; the same table is tried again on the next download.

`uploadStart`/`uploadFinish` bracket one local transaction being pushed upstream, discarded batches
included - see [Error handling](#error-handling). A batch that stays queued after a transient
failure gets no `uploadFinish`; it is retried, and brackets its own attempt.

`connect`/`disconnect` only fire on the tab holding leadership, and only on an actual transition -
a channel that reports trouble more than once in a row without recovering does not get a
`disconnect` for each report.

### `supapower.status`

A PowerSync-like snapshot of what the sync is doing, derived entirely from the events above. It
exists as soon as `pg.supapower` does; nothing in it changes until `sync()` is called.

```ts
const sync = await pg.supapower.sync({ supabase, tables: ['todos'] });

pg.supapower.events.addEventListener('statusChange', () => {
  console.log(pg.supapower.status);
});
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

Every value is a new frozen object - `pg.supapower.status` before and after a `statusChange` are
never the same reference, which is what lets a React (or any other) subscriber treat it as an
external store snapshot. Between events the same reference is returned every time.

Each tab's status is entirely local: only the leader tab downloads, uploads and holds the realtime
channel - see [Multi-tab behavior](#multi-tab-behavior) below - so every field, `hasSynced`
included, stays `false` on a follower tab, even though its data keeps arriving through the shared
database. Read `leading` before trusting the rest of the status, or build a status indicator around
whichever tab is leading rather than the one your component happens to render in.

React apps get this as a hook, `useSupapowerStatus()`, from
[`@supapower/react`](https://github.com/aboviq/supapower/tree/main/packages/react#readme).

### Multi-tab behavior

Every tab that opens the same PGlite database shares one set of files, and therefore one
`supapower.changes` queue. Exactly one tab may drain it, otherwise the same batch is pushed twice.

#### Setting it up

Opening a plain `PGlite` instance against the same `dataDir` from several tabs risks corrupting the
database no matter what Supapower does with the queue - only ever touch the files from one process,
using a worker.

[`@supapower/worker`](https://github.com/aboviq/supapower/tree/main/packages/worker#readme) is the
more stable option: one `SharedWorker` hosts the database for every tab instead of one tab owning it,
falling back automatically to PGlite's own dedicated worker where `SharedWorker` isn't available.

```ts
// ./pglite-worker.ts
import { worker } from '@supapower/worker/worker';
import { IdbFs, PGlite } from '@electric-sql/pglite';

worker({
  async init() {
    const pg = new PGlite({
      fs: new IdbFs('your-app'),
      relaxedDurability: true,
    });

    // Preferably run any database migrations here...

    return pg;
  },
});
```

> [!NOTE]
> There are a few recommendations regarding how you create your database tables, see
> [database migrations](#database-migrations) below.

```ts
// ./pglite.ts
import { createPGliteWorker } from '@supapower/worker';
import { supapower } from 'supapower';

export const pg = await createPGliteWorker(
  {
    shared: () =>
      new SharedWorker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' }),
    fallback: () => new Worker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' }),
  },
  { id: 'your-app', extensions: { supapower } },
);
```

You can use [PGlite's own dedicated multi-tab worker](https://pglite.dev/docs/multi-tab-worker)
instead if you'd rather not add the extra package - the setup is the same shape, just without the
`SharedWorker` fallback, and `id` is optional rather than required. The downside with this approach is that queries may be frozen in non-leading tabs if the browser decides to save resources by throttling or suspending background tabs (i.e. the leader tab in that case).

With the `SharedWorker` approach above this problem is mitigated, as the shared worker continues to run independently of individual tabs, ensuring that queries are not frozen even when the user switches away from the tab that initially started the worker.

#### How leadership works

That lock cannot live in Postgres. PGlite is a single-connection engine and every tab runs its own
instance, so `pg_advisory_lock()` is invisible to the other tabs and would block the only connection
this one has. Supapower coordinates in the browser instead, and picks the strongest mechanism the
runtime offers:

| `leadership`     | When                                                   | Mechanism                                                                                                                                                      |
| ---------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visible-tab`    | A browser tab                                          | An exclusive [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) named `supapower:outgoing:<scope>`, held only while the tab is visible |
| `web-lock`       | A browser context without a `document` (e.g. a worker) | The same lock, held unconditionally                                                                                                                            |
| `single-process` | Node, Bun, Deno                                        | None - a second process is assumed not to exist                                                                                                                |

Leadership moves on its own when the leading tab is hidden, closed or crashes: a Web Lock is
released by the browser when the tab closes or crashes, and a visible tab gives it up the instant
it is hidden. A hidden tab never drains the queue - browsers throttle or freeze timers in hidden
tabs, so a hidden leader would stall the queue for every tab - and no tab drains while every tab is
hidden. Read `sync.leadership` to see which mechanism you ended up with.

Leadership moving between tabs starts a fresh syncer each time, but it does not mean a fresh
download every time: `downloadThrottle` skips a table whose last download is still within the
window, so switching tabs repeatedly inside that window re-downloads nothing.

### Error handling

A failed upload is one of two things, and Supapower treats them differently.

**Transient** - offline, a 5xx, a dropped connection. The outgoing batch stays queued and is retried with an
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
  /** The failure, with the PostgREST error itself as `error.cause`. */
  readonly error: SupapowerUploadError;
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

Uploads are idempotent by design - an insert upserts on the primary key, an update sets only the
columns it changed, a delete goes by primary key - because a crash between the upload and the queue
delete leaves the batch queued for the next leader to send again. See [Conflicts](#conflicts) for
what an update does about a row somebody else touched in the meantime.

#### The `error` event

Anything that goes wrong without stopping the sync is dispatched as an `error` event on
[`supapower.events`](#supapowerevents), and without a listener every one of those passes silently:
an upload or download that failed and will be retried, a realtime channel reporting trouble, a
change that could not be applied locally, and a `DELETE` that matched no row upstream.

`event.error` is always a `SupapowerError`, never a bare `unknown`. Whatever was actually thrown - a
`TypeError` from `fetch`, a PGlite error, a string - is wrapped and kept as `cause`, so there is a
`code` to switch on without narrowing anything first:

```ts
pg.supapower.events.addEventListener('error', ({ error }) => {
  switch (error.code) {
    case 'delete_ignored':
      // Local and remote have diverged; the row is still upstream.
      break;
    case 'connection_failed':
      setOffline(true);
      break;
    default:
      report(error.message, { cause: error.cause });
  }
});

const sync = await pg.supapower.sync({ supabase, tables: ['todos'] });
```

| `code`              | What happened                                                    |
| ------------------- | ---------------------------------------------------------------- |
| `upload_failed`     | Something in the outgoing pipeline failed and will be retried    |
| `download_failed`   | Reading from Supabase failed                                     |
| `apply_failed`      | A remote change could not be written into the local database     |
| `column_ignored`    | A remote row carried a column this client's schema does not have |
| `connection_failed` | The realtime channel could not be reached or stay joined         |
| `delete_ignored`    | Supabase accepted a `DELETE` that matched no row                 |
| `update_ignored`    | Supabase accepted an `UPDATE` that matched no row                |
| `schema_mismatch`   | A queued change names a table that is not configured for syncing |
| `filter_failed`     | A table's `filter` callback failed, so the table is not syncing  |

`asSupapowerError(value, message, code)` from `supapower/errors` is the same wrapper, if you want to
funnel your own failures into the same shape.

The last two are worth knowing about. Row-level security refuses a write by filtering the row out of
the policy's `USING` clause, not by raising, so a denied `UPDATE` or `DELETE` comes back as an
ordinary success that changed nothing. Supapower counts the rows it touched and reports a definite
zero.

Reported, not thrown: a batch re-sent after a crash also matches nothing the second time, and failing
there would wedge the queue on a change that can never succeed. That makes the two cases
indistinguishable from the client - the row is gone upstream, or you may not write it.

### Entry points

Everything needed for the common case is on the package root. The rest is split per module.

| Import                 | Contains                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `supapower`            | `supapower` (the extension), `createSupapower`                                                            |
| `supapower/types`      | `SupapowerSyncOptions`, `SupapowerSync`, `SupapowerTableConfig`, `PGliteWithSupapower`, `SupapowerStatus` |
| `supapower/changes`    | `ChangeRow`, `UnrecoverableUploadError`, `SyncTransaction`                                                |
| `supapower/errors`     | `SupapowerError`, `SupapowerUploadError`, `asSupapowerError`, the guards and codes                        |
| `supapower/events`     | `SupapowerEventTarget`, `SupapowerErrorEvent`, `SupapowerTableEvent`                                      |
| `supapower/leadership` | `createLeadership` and the individual strategies                                                          |

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
  - but if a column is non-nullable but set by a trigger in the backend (e.g. `updated_at`) it is easier to keep it nullable in the client schema
- <kbd>S</kbd> give every column you add later a default, or make it nullable
  - an older client creating a row only sends the columns it knows about, so a new `NOT NULL` column without a default fails its insert with `23502`
  - `23502` counts as [unrecoverable](#error-handling), so the change is discarded rather than retried: every client still on the previous version silently stops being able to create rows
- <kbd>C</kbd> remove all foreign key constraints
  - keep the columns, but remove the constraints as we don't know/can't guarantee in which order rows will be synced
- <kbd>C</kbd><kbd>S</kbd> prefer soft deletes over `DELETE` queries, i.e. use a `deleted_at` column or similar and filter all queries with it
  - this recommendation is for the Supabase migrations as well because realtime events for deleted rows are not sent by default (see [Delete events limitation](https://supabase.com/docs/guides/realtime/postgres-changes#delete-events))
  - even with full replication and delete events are received via the realtime engine they will only sync to online users, this means that rows deleted by other users while you are offline will still be in your client's database
  - **bump `updated_at` in the same statement that sets `deleted_at`**, otherwise the deletion never reaches a client that is using [`cursor`](#table-cursor-configuration): an incremental download only asks for rows whose timestamp moved, so a soft delete that leaves `updated_at` alone is invisible to every client that was offline when it happened
- <kbd>C</kbd><kbd>S</kbd> give every synced table an `updated_at` column maintained by a trigger
  - a trigger rather than application code, so that no write path can forget it - one missed update is a row that silently stops syncing to offline clients
  - it is what [`cursor`](#table-cursor-configuration) needs to turn the full download on every start into an incremental one
- <kbd>S</kbd> bump `updated_at` on every row whose **visibility** changes, not just every row whose contents change
  - granting somebody access to a project, moving a document between teams, accepting an invitation: the rows themselves are untouched, so their timestamps do not move, so a client using [`cursor`](#table-cursor-configuration) never asks for them and never learns they exist
  - realtime does not cover the gap either, since it only delivers rows that actually change
  - the fix belongs in the statement that changes the access, alongside the membership row itself:

    ```sql
    UPDATE documents SET updated_at = now() WHERE project_id = new.project_id;
    ```

  - it is worth doing from a trigger on the membership table so that no code path granting access can forget, and worth keeping in mind when writing row-level security policies: **whatever a policy reads, a change to it has to move the timestamp of every row the policy decides about**
- <kbd>C</kbd><kbd>S</kbd> use `uuid`'s as primary keys
  - as the primary key is shared between the client and server databases and can be created at any end they shouldn't be able to collide, which is why a sequence number won't work
- <kbd>C</kbd><kbd>S</kbd> have a single primary key in every table that you want to sync
  - support for compound primary keys in Supapower has not been implemented yet
  - from my experience even when you want compound primary keys it's usually better to have a single PK with a unique key for the compound keys instead

**Conclusion:** relax your client database schema, have an `updated_at` column in every table (updated by triggers), use soft deletes and always use single primary keys as `uuid` columns.

## License

[Apache-2.0](LICENSE), Copyright 2026 Aboviq AB.
