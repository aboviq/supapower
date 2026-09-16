---
'supapower': minor
---

Survive a server that deploys a new column before its clients do.

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
