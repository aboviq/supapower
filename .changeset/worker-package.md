---
'@supapower/worker': minor
---

First release: a `SharedWorker`-backed multi-tab PGlite setup - one worker hosts the database for every tab instead of one tab owning it - falling back automatically to PGlite's own dedicated worker where `SharedWorker` isn't available. Works with plain PGlite; Supapower is optional.
