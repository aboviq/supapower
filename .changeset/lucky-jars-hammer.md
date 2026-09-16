---
'supapower': patch
---

Document that a row becoming visible is not the same as a row changing.

An incremental download asks for rows whose cursor column moved. Granting somebody access to a
project moves nothing on the project's rows - they were there all along, the policy just started
letting this user see them - so a client using `cursor` never asks for them and never learns they
exist. Realtime does not cover it either, since it only delivers rows that actually change.

The readme now says so under `cursor`, and the schema recommendations carry the fix: bump
`updated_at` on every row whose visibility changes, from a trigger on the table that grants the
access, so that no code path can forget.
