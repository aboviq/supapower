---
'supapower': minor
---

Make `primaryKey` work, and fix a migration that never ran at all.

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
