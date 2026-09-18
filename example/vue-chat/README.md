# Vue chat example

A browser chat app built on [Supapower](../../packages/supapower/) and
[`@supapower/vue`](../../packages/vue/): every browser tab shares one IndexedDB-backed
[PGlite](https://pglite.dev/) database through
[PGlite's multi-tab worker](https://pglite.dev/docs/multi-tab-worker), and messages sync to
Supabase in the background, both ways, so other browsers and devices see them too. Open the app in
two tabs to watch a message sent in one show up in the other instantly, through the shared local
database, before Supabase is even in the picture.

## Setup

### 1. Create the table in Supabase

Open the SQL editor of your Supabase project and run this. The `create table` statement matches
[`src/schema.ts`](./src/schema.ts)'s `MESSAGES_TABLE_SQL`, which the multi-tab worker also runs
against the local database every time it starts - keep the two in sync if you change one:

```sql
create table if not exists public.messages (
  id uuid primary key,
  user_id uuid not null,
  user_name text not null,
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

-- Demo-only policies: anyone with the anon key can read and write. Do not
-- ship this to a real project - see "No authentication" below.
create policy "anyone can read messages" on public.messages
  for select using (true);

create policy "anyone can insert messages" on public.messages
  for insert with check (true);

-- Required for realtime changes to reach connected clients.
alter publication supabase_realtime add table public.messages;
```

Also make sure the `public` schema is exposed in **Project Settings → Data API**, which it is by
default.

### 2. Configure your Supabase credentials

```bash
cp .env.example .env
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY` (the project URL and its anon/publishable key,
both found under **Project Settings → API** in the Supabase dashboard). Vite only exposes
`VITE_`-prefixed variables to browser code, and only reads `.env` when the dev server or build
starts - restart it after editing the file.

### 3. Run it

From the repository root:

```bash
bun install
bun run build
bun run --filter vue-chat-example dev
```

Or from this directory, after `bun install` and `bun run build` have run once from the repository
root:

```bash
bun run dev
```

Open <http://localhost:5173>. You'll be asked for a name, then dropped into the chat. Open a second
tab and run it again to see the two sides sync, both through the shared local database and through
Supabase.

For a production build, use `bun run --filter vue-chat-example build` followed by
`bun run --filter vue-chat-example preview`.

The chat works locally even before `VITE_SUPABASE_URL`/`VITE_SUPABASE_KEY` point at a real project:
typing and sending a message still writes it to the local table and shows it immediately in every
open tab, since that part never touches the network. Sync failures against a wrong or unreachable
project surface next to the status line (e.g.
`● connected · Could not download "public"."messages" from Supabase: ...`) instead of crashing the
app - that is expected until the credentials and the table above are both in place.

## Multi-tab behavior

Every tab opens the same worker-hosted PGlite database, so every tab sees the same rows - a message
typed in one tab appears in every other tab's list immediately, through the shared local database,
whether or not Supabase is reachable. Each tab is still its own chat user: your name is stored in
that tab's `sessionStorage`, so opening a second tab asks for a name again.

Only one tab - the elected leader - downloads, uploads and holds the Supabase realtime channel; every
other tab is a follower and its status line reads `○ follower · another tab is syncing` instead of
`● connected`/`○ connecting…`/`○ idle`. Close the leader tab and PGlite re-runs its election; the
remaining tab takes over and its status line switches to the leader wording, with
`leadership: worker-leader` in both cases - see
[Multi-tab behavior](../../packages/supapower/README.md#multi-tab-behavior) in the core README for
why leadership exists and how it changes hands.

## What it demonstrates

- `extensions` from [`@supapower/vue`](../../packages/vue/), passed as the second argument to
  [`PGliteWorker.create`](https://pglite.dev/docs/multi-tab-worker) on the client side - not inside
  the worker's `init()`, since `PGliteWorker` strips `extensions` before forwarding options to the
  worker.
- `pg.supapower.sync()` with `access: 'anon'`, since this demo has no sign in flow - see
  [`SupapowerTableConfig.access`](../../packages/supapower/README.md#supapowertableconfig---tracked-tables-configuration)
  for what that controls.
- `providePGlite(pg)`, called inside the root component's `setup()` - not `app.provide` - because
  the injection key `@electric-sql/pglite-vue` uses is private to that package.
- `useLiveQuery.sql` keeping the message list current as rows arrive, whether typed in this tab,
  typed in another tab, or synced in from Supabase, all as Vue refs with no manual subscription.
- `useSupapowerStatus()`, reading `leading` before every other field: on a follower tab every other
  field stays `false` even though its data keeps arriving, so the status line branches on `leading`
  first.
- `sync.leadership` reporting which coordination mechanism won - `worker-leader` here, since the
  database is a `PGliteWorker`. See
  [Multi-tab behavior](../../packages/supapower/README.md#multi-tab-behavior) in the core README for
  the other mechanisms.

## Notable simplifications

- **No authentication.** A fresh `crypto.randomUUID()` is generated as the user id and stored in
  `sessionStorage` alongside the name, instead of signing in through `supabase.auth`, so the RLS
  policies above have to allow anonymous access. Do not use this table's policies as-is on anything
  but a throwaway project.
- **No incremental sync.** The table has no
  [`cursor`](../../packages/supapower/README.md#table-cursor-configuration) column, so every start
  downloads the whole message history rather than only what changed since last time. Fine for a chat
  demo, worth adding for a table that grows large.
- **No teardown on unload.** Unlike the [CLI example](../chat/), this app never calls
  `sync.unsubscribe()`: a page unload cannot await an asynchronous teardown, and closing the tab or
  browser already ends the realtime socket and any pending retry timers.
- **Persistent storage.** `src/pglite-worker.ts` opens PGlite with `IdbFs`, so data survives reloads
  - unlike the CLI example's in-memory database. To see the initial download from Supabase again,
    clear the site's storage from your browser's devtools (Application → Storage → IndexedDB).
- **A second TypeScript, scoped to this package.** This repository's `typescript` is `7.x`, whose
  native Go compiler dropped the classic compiler API `vue-tsc` needs to check `.vue` files. This
  package's own `devDependencies` alias `typescript` to Microsoft's `@typescript/typescript6`
  compatibility package instead, so `bun run --filter vue-chat-example typecheck` (`vue-tsc`) works
  without touching the `typescript@7` every other package in this repository builds with.

## Controls

- `Enter` (or the **Send** button) sends the message currently in the input field.
