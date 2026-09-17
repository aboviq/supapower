---
'supapower': minor
---

Add ability to sync tables that live outside the `public` schema.

`SupapowerTableConfig` takes a `schema` for where the table lives in Supabase, defaulting to
`public`, and a `localSchema` for where it lives in PGlite. Leave `localSchema` out and the local
table is expected in the same schema as the remote one. You can use `localSchema` to keep synced tables out of the local `public` schema or flatten several remote schemas into one.

The schema follows a table through the whole loop: triggers are attached to it and record the schema
they fired in, the outgoing queue drains changes matched on both halves, the Data API request and
the realtime binding name the remote schema, and an incoming row is written into the local one.

A table is now identified by both its schema and name, so `public.todos` and `app.todos` are two different tables
with separate triggers, watermarks and queued changes. Download watermarks in `supapower.metadata`
are keyed by qualified local name for the same reason.
