---
'supapower': minor
---

Report an update that matched no row as `update_ignored`.

An update that reached no row upstream used to fall back to sending the whole row, which resurrected
a row somebody else had deleted. It is now dropped and reported through `onError`, the same way a
`DELETE` that matched nothing already was.

The two causes are indistinguishable from the client - the row is gone, or row-level security hides
it - so the callback is where an application decides what to do with the local copy, which still
holds the edit.
