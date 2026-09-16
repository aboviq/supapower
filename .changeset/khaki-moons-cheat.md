---
'supapower': minor
---

Resolve concurrent edits per column, so two people editing one row both keep their change.

An update used to send the whole row upstream, which replaced whatever somebody else had changed in
the meantime. It now sends only the columns it actually changed, worked out from the before and after
images the change trigger already records. Edit `title` offline while somebody else edits `done` and
both survive - Postgres does the merge.

Locally, a row with an unsynced local change no longer has incoming changes written over it. That
used to happen, so an edit still waiting in the queue could be replaced by the older remote value; it
usually corrected itself when the queued change went upstream and came back over realtime, but the
row visibly flickered, and if the upload was rejected for good the edit was gone with nothing to say
so. Holding the incoming change back is now only a delay: the upload's own echo carries the merged
row back, and by then the queue is empty.

What is left is stated in the readme under "Conflicts": two clients editing the same column still
resolve last write wins, a delete still beats a concurrent edit, and converging relies on the
realtime echo or on `cursor` picking the row up at the next start.

Incoming inserts and updates are also applied the same way now, as an upsert on the primary key. An
update used to be a plain `UPDATE`, so one for a row this client never received the insert for
matched nothing at all and left the two silently apart. An outgoing update that matches nothing
upstream repairs itself the same way, by sending the whole row the queue still holds.
