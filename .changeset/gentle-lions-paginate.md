---
'supapower': minor
---

Fixed two data-loss bugs in the download path:

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
