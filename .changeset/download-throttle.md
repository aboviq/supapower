---
'supapower': minor
---

Added a `downloadThrottle` option to `sync()` (default `60_000` ms). Leadership follows tab visibility, so switching tabs repeatedly used to start a fresh download of every table on each switch; a table whose last completed download finished more recently than `downloadThrottle` is now skipped instead. A table whose configured `cursor` or local columns have changed since it was last downloaded, and the catch-up download after a dropped realtime connection, always download regardless.

The per-table sync record stored in `supapower.metadata` has been renamed from `SyncedCursorAt` to `TableSyncState` and is now written for every table, not only ones with a `cursor`. Existing installations download every table whole once on the first start after upgrading.
