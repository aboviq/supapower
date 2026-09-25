---
'supapower': minor
---

Added a `redownload` method to the object `sync()` returns, for a visibility change row-level security decides but no table's `filter` reflects - typically a claim in a refreshed access token. `await sync.redownload(['todos'])` empties that table locally and downloads it whole again, ignoring both the download throttle and any `cursor` watermark; called with no arguments it does every configured table. Neither a download nor a realtime subscription ever reports a row that stopped being visible, so the table has to start from empty to be described completely - the same reason a changed `filter` truncates before it re-downloads.

`redownload()` resolves once the request has been recorded and the syncing tab has been woken, not once the data has landed - `downloadTableFinish` or `supapower.status` still report the download itself, the same as any other one. Queued local changes for the table are left alone and still upload.
