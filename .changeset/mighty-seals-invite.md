---
'supapower': minor
---

Give `onError` a `SupapowerError`, never a bare `unknown`.

The callback documented a `code` you could switch on but typed its parameter `unknown`, so every
handler had to narrow before it could read the thing the documentation promised. Everything reaching
a Supapower callback is now wrapped: whatever was actually thrown - a `TypeError` from `fetch`, a
PGlite error, a string - is kept as `cause` under a `SupapowerError` carrying a code that says what
Supapower was doing when it failed.

`UnrecoverableUploadError.error` is typed as `SupapowerUploadError` for the same reason, which means
`error.cause` is the PostgREST error itself rather than something to inspect at runtime.

Two new codes name what used to be lumped together: `apply_failed` for a remote change that could not
be written into the local database, and `connection_failed` for a realtime channel that could not be
reached or stay joined. `asSupapowerError` is exported from `supapower/errors` for wrapping your own
failures into the same shape, and `isUnrecoverableUploadError` is now a type guard.
