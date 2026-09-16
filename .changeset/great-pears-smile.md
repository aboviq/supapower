---
'supapower': patch
---

Cover applying incoming changes against a real database.

`handleIncomingChange` builds its SQL by hand and was only ever exercised against a stub that never
parsed what it was handed - the same blind spot that hid a broken `CREATE FUNCTION` until the
migrations got real coverage. It now has integration tests running against an actual PGlite instance:
insert, update and delete, upserting on a configured primary key rather than `id`, quoting of
reserved words and spaces in identifiers, the trigger suppression that keeps an applied change from
echoing straight back out, and the watermark moving in the same transaction as the row.
