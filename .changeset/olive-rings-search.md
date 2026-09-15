---
'supapower': minor
---

Sync outgoing local changes to Supabase, with only one tab doing the syncing.

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
