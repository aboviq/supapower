---
'supapower': minor
---

Download only what changed, for tables that say how.

`SupapowerTableConfig` takes a `cursor`: the name of a timestamp column that moves on every write,
typically `updated_at`. Given one, every download after the first asks only for rows at or after the
last value it saw instead of pulling the whole table again. Tables without a `cursor` keep working
exactly as before.

The download reaches a minute further back than the last value it saw. A write stamps its timestamp
with the transaction's start time but only becomes visible once it commits, so a slow transaction
can land a row behind a watermark that has already moved past it; the margin covers that. The
watermark only ever moves forward, and is forgotten whenever the table is truncated for a user
change, so that always starts from a whole download again.

Hard `DELETE`s cannot be picked up this way - the row is simply gone - which is why soft deletes are
recommended. The readme now also spells out that `updated_at` has to be bumped in the same statement
that sets `deleted_at`, since a soft delete that leaves the timestamp alone is invisible to every
client that was offline when it happened.
