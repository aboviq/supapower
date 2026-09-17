---
'supapower': minor
---

Add `pg.supapower.events`, a typed `EventTarget` reporting sync progress, connectivity, and errors.

Dispatches `downloadStart`, `downloadTableStart`/`downloadTableFinish` (with `event.config`),
`downloadFinish`, `uploadStart`, `uploadFinish`, `connect`/`disconnect` for the realtime channel, and
`error` (with `event.error`). It exists as soon as the namespace does, so listeners can be attached
before `sync()` is ever called, and more than one listener can watch the same event - enough to drive
a reactive sync status object.

**Breaking:** the `onError` option on `sync()` is removed. Use
`pg.supapower.events.addEventListener('error', ({ error }) => ...)` instead. `onUnrecoverableError` is
unchanged - it still needs to be awaited and to control whether a rejected batch is discarded, which a
fire-and-forget event cannot do.
