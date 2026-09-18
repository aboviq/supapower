# supapower

## 0.2.0

### Minor Changes

- [`616b24c`](https://github.com/aboviq/supapower/commit/616b24ce448efccde60270c119e03f3499fd2245) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Adds `pg.supapower.status`, a PowerSync-like snapshot of what the sync is doing, and a `statusChange` event dispatched on `pg.supapower.events` whenever it changes.

## 0.1.0

### Minor Changes

- [`e2329e5`](https://github.com/aboviq/supapower/commit/e2329e5b12539f8adb2f75ce8c6c531d5b89dedb) Thanks [@joakimbeng](https://github.com/joakimbeng)! - `unsubscribe()` now returns a `Promise<void>` that resolves once the sync has fully torn down -
  leaving the Supabase realtime channel and letting an in-flight change finish applying - instead of
  only `void`. Calling it without awaiting behaves exactly as before: everything that can stop
  synchronously still stops before the first `await`.
  
  Never rejects: a failure while tearing down (for example the realtime channel could not be left) is
  reported through the `error` event instead.
  
  **Breaking:** the type of `unsubscribe()` changed from `(): void` to `(): Promise<void>`. Callers
  that only invoked it are unaffected; a caller relying on its return type being `void` needs to update.

- [`5c2534a`](https://github.com/aboviq/supapower/commit/5c2534a5089f398f28e8a6964781b1480c621503) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Apply remote changes locally over Supabase Realtime.
  
  The leading tab now also subscribes to `postgres_changes` for the configured tables and writes each
  change straight into the local database, with `supapower.applying` set so the change triggers do not
  queue it right back up as an outgoing change. Applying a row and advancing its watermark in
  `supapower.metadata` happen in one transaction, and changes are applied in the order they were
  broadcast.
  
  Which tables are subscribed to follows the signed in user: tables marked `access: 'anon'` at all
  times, the rest only while somebody is signed in. The subscription is rebuilt when the user changes,
  and deliberately left alone when only the token was refreshed - supabase-js pushes a refreshed token
  onto the realtime socket by itself, so re-subscribing would drop messages for nothing. A client built
  with the `accessToken` option owns its token and is treated as always signed in.
  
  Like the outgoing queue, this runs on the leading tab only: every tab shares one database, so a
  subscription per tab would apply each change once per open tab.

- [`792d02e`](https://github.com/aboviq/supapower/commit/792d02ec0d0d5dd5786b9ed4f2d2979eafc95c3f) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Add ability to sync tables that live outside the `public` schema.
  
  `SupapowerTableConfig` takes a `schema` for where the table lives in Supabase, defaulting to
  `public`, and a `localSchema` for where it lives in PGlite. Leave `localSchema` out and the local
  table is expected in the same schema as the remote one. You can use `localSchema` to keep synced tables out of the local `public` schema or flatten several remote schemas into one.
  
  The schema follows a table through the whole loop: triggers are attached to it and record the schema
  they fired in, the outgoing queue drains changes matched on both halves, the Data API request and
  the realtime binding name the remote schema, and an incoming row is written into the local one.
  
  A table is now identified by both its schema and name, so `public.todos` and `app.todos` are two different tables
  with separate triggers, watermarks and queued changes. Download watermarks in `supapower.metadata`
  are keyed by qualified local name for the same reason.

- [`e7b6007`](https://github.com/aboviq/supapower/commit/e7b600777d85562b19eed6a60542e693e30db391) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Download the configured tables on start, and clear them out when the user changes.
  
  The leading tab now runs an initial download before streaming: every row of every table the signed
  in user can reach is fetched with `select()` and written in through the same path as a realtime
  INSERT, so the upsert on the primary key makes re-running it harmless. The channel is subscribed to
  first, so a change made while the download is in flight queues up behind the snapshot instead of
  falling in the gap between the two.
  
  Tables left on the default `access: 'authenticated'` are truncated whenever the signed in user
  changes, in either direction, and re-downloaded for the new one. The user the local data was last
  synced for is kept in `supapower.metadata`, so a reload with somebody else signed in is caught too.
  
  Queued outgoing changes for those tables are dropped along with the rows: they were made by the
  previous user and cannot be pushed upstream as the next one. Unsynced local work on an
  `authenticated` table is therefore lost on sign out.

- [`0d4e24f`](https://github.com/aboviq/supapower/commit/0d4e24fed8c9379e18080cd81741bff27f33dd0c) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Fixed two data-loss bugs in the download path:
  
  - A table with more than 1,000 rows (Supabase's default `max-rows` cap) now downloads completely
    instead of silently truncating to an arbitrary 1,000-row subset. `downloadTable` keyset-paginates
    on each table's primary key, and the incremental-sync watermark is only written once the whole
    table has been paged through - a mid-table watermark could otherwise claim coverage of rows that
    had not been fetched yet.
  - A single failed download (a transient 5xx, a mistyped `cursor` column, etc.) no longer leaves the
    local database unpopulated for the rest of the session. `runIncomingSync` now retries a failed
    download with the same exponential backoff the outgoing queue already uses, instead of giving up
    after one attempt.
  
  Also: syncing a table that has not been created locally now fails with a clear
  "does not exist in the local database" error instead of a misleading primary-key error.

- [`a16a480`](https://github.com/aboviq/supapower/commit/a16a480455511897a8b89988c368a09d397afcdc) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Resolve concurrent edits per column, so two people editing one row both keep their change.
  
  An update used to send the whole row upstream, which replaced whatever somebody else had changed in
  the meantime. It now sends only the columns it actually changed, worked out from the before and after
  images the change trigger already records. Edit `title` offline while somebody else edits `done` and
  both survive - Postgres does the merge.
  
  Locally, a row with an unsynced local change no longer has incoming changes written over it. That
  used to happen, so an edit still waiting in the queue could be replaced by the older remote value; it
  usually corrected itself when the queued change went upstream and came back over realtime, but the
  row visibly flickered, and if the upload was rejected for good the edit was gone with nothing to say
  so. Holding the incoming change back is now only a delay: the upload's own echo carries the merged
  row back, and by then the queue is empty.
  
  What is left is stated in the readme under "Conflicts": two clients editing the same column still
  resolve last write wins, a delete still beats a concurrent edit, and converging relies on the
  realtime echo or on `cursor` picking the row up at the next start.
  
  Incoming inserts and updates are also applied the same way now, as an upsert on the primary key. An
  update used to be a plain `UPDATE`, so one for a row this client never received the insert for
  matched nothing at all and left the two silently apart. An outgoing update that matches nothing
  upstream repairs itself the same way, by sending the whole row the queue still holds.

- [`b2905f5`](https://github.com/aboviq/supapower/commit/b2905f51e9523ebdce43a98e8d6c743130fbc90f) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Make `primaryKey` work, and fix a migration that never ran at all.
  
  The `UPDATE` branch of the change trigger paired old and new rows with a hardcoded `ON o.id = n.id`,
  so any table configured with a different `primaryKey` - `{ table: 'tags', primaryKey: 'tag_id' }`,
  straight out of the readme's own example - raised `column o.id does not exist` on every local update.
  The pairing now goes through `to_jsonb(row) ->> primary_key`, with the key handed to the trigger as
  an argument, which works for any column name without dynamic SQL.
  
  `trackTables` also checks that the configured key really is a column and refuses to start when it is
  not. Without the check a missing key would make the join compare `NULL` to `NULL` and silently record
  no updates at all.
  
  Fixes a second problem found while testing this against a real PGlite rather than a stub: the
  `pg_notify` call inside the trigger function was passed as a bind parameter, which Postgres rejects
  in DDL with `08P01`. `runMigrations` therefore failed on its first call, meaning no table was ever
  tracked. It is inlined now.

- [`30e3e9b`](https://github.com/aboviq/supapower/commit/30e3e9bedb85bc9c3dc3e1481d8f8eac32118c62) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Give `onError` a `SupapowerError`, never a bare `unknown`.
  
  The callback documented a `code` you could switch on but typed its parameter `unknown`, so every
  handler had to narrow before it could read the thing the documentation promised. Everything reaching
  a Supapower callback is now wrapped: whatever was actually thrown - a `TypeError` from `fetch`, a
  PGlite error, a string - is kept as `cause` under a `SupapowerError` carrying a code that says what
  Supapower was doing when it failed.
  
  `UnrecoverableUploadError.error` is typed as `SupapowerUploadError` for the same reason, which means
  `error.cause` is the PostgREST error itself rather than something to inspect at runtime.
  
  Two new codes name what used to be lumped together: `apply_failed` for a remote change that could not
  be written into the local database, and `connection_failed` for a realtime channel that could not be
  reached or stay joined. `asSupapowerError` is exported from `supapower/errors` for wrapping your own
  failures into the same shape, and `isUnrecoverableUploadError` is now a type guard.

- [`b14b06b`](https://github.com/aboviq/supapower/commit/b14b06bc7e2a3a57de4f23e9766ce73b3e057a47) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Notice a `DELETE` that Supabase quietly ignored, and add `onError`.
  
  Row-level security refuses a delete by filtering the row out of the policy's `USING` clause rather
  than raising, so a denied `DELETE` came back as an ordinary success that removed nothing - and the
  change was committed as synced while the row sat untouched upstream. The delete now asks PostgREST to
  count what it removed and reports a definite zero.
  
  It is reported rather than thrown: a batch re-sent after a crash legitimately deletes nothing the
  second time, and failing there would wedge the queue on a change that can never succeed again. The
  two cases cannot be told apart from the client, so `delete_ignored` means either the row was already
  gone or the delete was refused.
  
  Reporting it needed somewhere to report to, so `SupapowerSyncOptions` takes an `onError`. It receives
  everything that went wrong without stopping the sync - a retried upload or download, a realtime
  channel in trouble, a change that could not be applied locally, and the ignored deletes. All of that
  used to pass silently with no way to observe it.

- [`e824258`](https://github.com/aboviq/supapower/commit/e8242589c9137a2d88d88a15938abbba7471f874) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Sync outgoing local changes to Supabase, with only one tab doing the syncing.
  
  `pg.supapower.sync()` sets up the `supapower` schema, attaches change triggers to the configured
  tables and starts draining the outgoing queue. It returns a `SupapowerSync` handle with
  `unsubscribe()` and the leadership strategy it settled on, and accepts an `AbortSignal` as an
  alternative way to stop.
  
  Because every tab shares one PGlite database, exactly one of them may drain the queue. Supapower
  picks the strongest coordination the runtime offers: `PGliteWorker`'s own leader election when the
  database is worker-backed, a named Web Lock for a plain `PGlite` instance in a browser, and no
  coordination outside the browser. Leadership is handed over automatically when a tab closes.
  
  Uploads are idempotent, so a batch that was sent but not committed is simply re-sent by the next
  leader. Transient failures are retried with an exponential backoff. A batch Supabase rejects for
  good - a constraint violation, a type mismatch, a row-level security denial - would otherwise block
  every change behind it, so it is discarded by default; pass `onUnrecoverableError` to save, report
  or park it instead.

- [`8566fe4`](https://github.com/aboviq/supapower/commit/8566fe4d4d1b84b5a685934146fe0301bc3805d1) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Download only what changed, for tables that say how.
  
  `SupapowerTableConfig` takes a `cursor`: the name of a timestamp column that moves on every write,
  typically `updated_at`. Given one, every download after the first asks only for rows at or after the
  last value it saw instead of pulling the whole table again. Tables without a `cursor` keep working
  exactly as before.
  
  The download reaches a minute further back than the last value it saw. A write stamps its timestamp
  with the transaction's start time but only becomes visible once it commits, so a slow transaction
  can land a row behind a watermark that has already moved past it; the margin covers that. The
  watermark only ever moves forward, and is forgotten whenever the table is truncated for a user
  change, so that always starts from a whole download again.
  
  Hard `DELETE`s cannot be picked up this way - the row is simply gone - which is why soft deletes are
  recommended. The readme now also spells out that `updated_at` has to be bumped in the same statement
  that sets `deleted_at`, since a soft delete that leaves the timestamp alone is invisible to every
  client that was offline when it happened.

- [`dbb70af`](https://github.com/aboviq/supapower/commit/dbb70af718ef05d25d623da41750332cc29c5b74) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Wait for the auth client before syncing anything, in either direction.
  
  The outgoing queue used to start draining the moment a tab won leadership, before anything was known
  about who was signed in. Both directions now start from the first `onAuthStateChange` notification,
  which supabase-js queues until its own initialization has settled and therefore doubles as an
  "authentication is ready" signal, session or no session.
  
  The HTTP requests were never the race - supabase-js resolves the token per request and that blocks on
  the same initialization - but a queue drained before the session is known is drained with whatever
  token happens to exist. After a reload with an expired refresh token that is the anon key, and every
  change to an `authenticated` table comes back as a row-level security denial, which the outgoing loop
  treats as unrecoverable and discards.
  
  The outgoing queue is now also filtered by what the current user can reach: changes to tables a
  signed out client has no session for stay queued instead of being pushed anonymously. A local
  transaction touching both reachable and unreachable tables only has the pushed half removed from the
  queue.
  
  Both directions share one abort signal per identity, so signing out stops an upload in flight rather
  than letting it finish as the wrong user.

- [`f683d86`](https://github.com/aboviq/supapower/commit/f683d86187b11f7be0985bf4cc093cba32d1f358) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Report an update that matched no row as `update_ignored`.
  
  An update that reached no row upstream used to fall back to sending the whole row, which resurrected
  a row somebody else had deleted. It is now dropped and reported through `onError`, the same way a
  `DELETE` that matched nothing already was.
  
  The two causes are indistinguishable from the client - the row is gone, or row-level security hides
  it - so the callback is where an application decides what to do with the local copy, which still
  holds the edit.

- [`ace2c7b`](https://github.com/aboviq/supapower/commit/ace2c7bc56c0904f95749fc4e6d58d1ddddfa331) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Survive a server that deploys a new column before its clients do.
  
  A remote row carrying a column the local schema has never heard of used to fail the whole change
  with `42703`, and the incoming sync retried it forever. It now fits the row to the schema instead:
  
  - The initial download asks Supabase for the columns this client knows by name, so an unknown one is
    never sent in the first place.
  - A realtime change that carries one has it trimmed off before the row is written, and the column is
    reported once per session through `onError` as `column_ignored`. The rest of the row still lands.
  
  Nothing is lost by trimming. An `upsert` only sets the columns it sends, so an old client updating a
  row leaves the newer column's value untouched upstream - the value is not gone, only not local yet.
  To pick it up once the application migration adds the column, the cursor watermark now records what
  it is worth: the value, the column it was read from, and the columns the download asked for. Ask for
  a column that watermark never covered and the table is downloaded whole again.
  
  That last part also fixes a silent bug: pointing `cursor` at a different column used to reuse a
  watermark read out of the old one, which fetched the wrong set of rows with no error to show for it.
  
  `ResolvedTableConfig` carries the table's local columns, read once per `sync()`, which also replaces
  the separate query the primary key check used to make.

- [`5b78053`](https://github.com/aboviq/supapower/commit/5b780537bb2c0793773d5ac0906937a0d49c828c) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Add `pg.supapower.events`, a typed `EventTarget` reporting sync progress, connectivity, and errors.
  
  Dispatches `downloadStart`, `downloadTableStart`/`downloadTableFinish` (with `event.config`),
  `downloadFinish`, `uploadStart`, `uploadFinish`, `connect`/`disconnect` for the realtime channel, and
  `error` (with `event.error`). It exists as soon as the namespace does, so listeners can be attached
  before `sync()` is ever called, and more than one listener can watch the same event - enough to drive
  a reactive sync status object.
  
  **Breaking:** the `onError` option on `sync()` is removed. Use
  `pg.supapower.events.addEventListener('error', ({ error }) => ...)` instead. `onUnrecoverableError` is
  unchanged - it still needs to be awaited and to control whether a rejected batch is discarded, which a
  fire-and-forget event cannot do.

### Patch Changes

- [`a3c0d0e`](https://github.com/aboviq/supapower/commit/a3c0d0e10f10c1ca2cab5fe3c9a8c34e93c654bc) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Cover applying incoming changes against a real database.
  
  `handleIncomingChange` builds its SQL by hand and was only ever exercised against a stub that never
  parsed what it was handed - the same blind spot that hid a broken `CREATE FUNCTION` until the
  migrations got real coverage. It now has integration tests running against an actual PGlite instance:
  insert, update and delete, upserting on a configured primary key rather than `id`, quoting of
  reserved words and spaces in identifiers, the trigger suppression that keeps an applied change from
  echoing straight back out, and the watermark moving in the same transaction as the row.

- [`73283fa`](https://github.com/aboviq/supapower/commit/73283fa3787c95db43280e129d92e63fd4883c32) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Document that a row becoming visible is not the same as a row changing.
  
  An incremental download asks for rows whose cursor column moved. Granting somebody access to a
  project moves nothing on the project's rows - they were there all along, the policy just started
  letting this user see them - so a client using `cursor` never asks for them and never learns they
  exist. Realtime does not cover it either, since it only delivers rows that actually change.
  
  The readme now says so under `cursor`, and the schema recommendations carry the fix: bump
  `updated_at` on every row whose visibility changes, from a trigger on the table that grants the
  access, so that no code path can forget.

- [`792d02e`](https://github.com/aboviq/supapower/commit/792d02ec0d0d5dd5786b9ed4f2d2979eafc95c3f) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Refactor code to avoid unnecessary iterations and keeping them to a minimum

- [`fb8b903`](https://github.com/aboviq/supapower/commit/fb8b903f026d445387ab9ec4982ca281db401aa9) Thanks [@joakimbeng](https://github.com/joakimbeng)! - Remove the unused `not_initialized` error code.
