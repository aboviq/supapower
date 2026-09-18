# Chat example

A terminal chat app built on [Supapower](../../packages/supapower/): every message is written to a
local, in-memory [PGlite](https://pglite.dev/) database first and synced to Supabase in the
background, both ways. Run it in two terminals to watch messages sent in one show up in the other.

```
╭───────────────────────────────────────────────╮
│                                               │
│                          hey, anyone there? ⋯ │
│  Bob: yep, reading you loud and clear         │
│                                               │
╰───────────────────────────────────────────────╯
● connected
╭───────────────────────────────────────────────╮
│Alice: _                                       │
╰───────────────────────────────────────────────╯
```

Your own messages render on the right, everybody else's on the left.

## Setup

### 1. Create the table in Supabase

Open the SQL editor of your Supabase project and run this. The `create table` statement matches
[`src/schema.ts`](./src/schema.ts)'s `MESSAGES_TABLE_SQL`, which the app also prints and runs against
the local database on every start - keep the two in sync if you change one:

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

Fill in `SUPABASE_URL` and `SUPABASE_KEY` (the project URL and its anon/publishable key, both found
under **Project Settings → API** in the Supabase dashboard).

### 3. Run it

From the repository root:

```bash
bun install
bun run --filter chat-example start
```

Or from this directory:

```bash
bun install
bun run start
```

You'll be asked for a name, then dropped into the chat. Open a second terminal and run it again to
see the two sides sync through Supabase.

The chat works locally even before `SUPABASE_URL`/`SUPABASE_KEY` point at a real project: typing and
sending a message still writes it to the local table and shows it immediately, since that part never
touches the network. Sync failures against a wrong or unreachable project surface next to the status
line (e.g. `○ · Could not download "public"."messages" from Supabase: ...`) instead of crashing the
app - that is expected until the credentials and the table above are both in place.

## What it demonstrates

- `pg.supapower.sync()` with `access: 'anon'`, since this demo has no sign in flow - see
  [`SupapowerTableConfig.access`](../../packages/supapower/README.md#supapowertableconfig---tracked-tables-configuration)
  for what that controls.
- [`pg.supapower.events`](../../packages/supapower/README.md#supapowerevents) driving the
  `● connected` / `○ connecting…` status line off the `connect`/`disconnect` events, and surfacing
  the last `error` event next to it.
- [PGlite's React hooks](https://pglite.dev/docs/framework-hooks/react) (`@electric-sql/pglite-react`)
  - `useLiveQuery.sql` keeping the message list up to date as rows arrive, whether typed locally or
    synced in from Supabase, without a `useState`/`useEffect` pair of our own for it.
  - `PGliteProvider` wraps the app so that hook can find the database.

## Notable simplifications

- **In-memory only.** `PGlite.create()` is called without a `dataDir` or `fs`, so every start begins
  with an empty local database - that's what makes it easy to see the initial sync bring history back
  from Supabase. A real app would persist locally (`NodeFS`/`IdbFs`, see the
  [main README](../../packages/supapower/README.md#2-set-up-pglite)).
- **No authentication.** A fresh [UUIDv7](https://bun.sh/reference/bun/randomUUIDv7) is generated as
  the user id on every start instead of signing in through `supabase.auth`, so the RLS policies above
  have to allow anonymous access. Do not use this table's policies as-is on anything but a throwaway
  project.
- **No incremental sync.** The table has no [`cursor`](../../packages/supapower/README.md#table-cursor-configuration)
  column, so every start downloads the whole message history rather than only what changed since last
  time. Fine for a chat demo, worth adding for a table that grows large.

## Controls

- `Enter` sends the message currently in the input field.
- `Ctrl+C` quits and unsubscribes from the sync.
