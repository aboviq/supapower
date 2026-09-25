---
'supapower': minor
---

Added a `filter` option to a table's configuration, for syncing a subset of its rows. The callback is handed a filter builder and the current session, and the filter it returns narrows both the PostgREST download and the `postgres_changes` subscription: `filter: (filter, session) => filter.eq('workspace_id', session?.user.app_metadata['workspace'])`. Conditions are `AND`ed, and row-level security still decides what the filter is allowed to return.

Filters are resolved per session, so an auth event that changes a claim a callback reads - a token refresh included - resolves a different filter and restarts the sync; an auth event that changes nothing is ignored as before. A table whose filter changed is truncated before it is downloaded again, since neither a filtered download nor a filtered subscription ever reports a row that stopped matching. A callback that throws stops that table from downloading and subscribing for that session, reported through the `error` event as the new `filter_failed` code, while its queued changes still upload.

The `@supabase/supabase-js` peer range tightens to `^2.116.0`: conditions are serialized through that release's `postgresChangesFilter()` builder, so both ends of the sync agree on how a value is quoted.
