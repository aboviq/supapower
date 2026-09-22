# @supapower/worker

## 0.1.0

### Minor Changes

- [`bbcf38c`](https://github.com/aboviq/supapower/commit/bbcf38caca3c18e21cb96667a4add6e27c2154c7) Thanks [@joakimbeng](https://github.com/joakimbeng)! - First release: a `SharedWorker`-backed multi-tab PGlite setup - one worker hosts the database for every tab instead of one tab owning it - falling back automatically to PGlite's own dedicated worker where `SharedWorker` isn't available. Works with plain PGlite; Supapower is optional.
