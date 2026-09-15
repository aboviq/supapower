---
'supapower': minor
---

Download the configured tables on start, and clear them out when the user changes.

The leading tab now runs an initial download before streaming: every row of every table the signed
in user can reach is fetched with `select()` and written in through the same path as a realtime
INSERT, so the upsert on the primary key makes re-running it harmless. The channel is subscribed to
first, so a change made while the download is in flight queues up behind the snapshot instead of
falling in the gap between the two.

Tables left on the default `access: 'authenticated'` are truncated whenever the signed in user
changes, in either direction, and re-downloaded for the new one. The user the local data was last
synced for is kept in `supapower.metadata`, so a reload with somebody else signed in is caught too.

Queued outgoing changes for those tables are dropped along with the rows: they were made by the
previous user and cannot be pushed upstream as the next one. Unsynced local work on an
`authenticated` table is therefore lost on sign out.
