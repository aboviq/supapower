---
'supapower': minor
---

Apply remote changes locally over Supabase Realtime.

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
