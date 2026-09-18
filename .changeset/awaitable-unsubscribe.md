---
'supapower': minor
---

`unsubscribe()` now returns a `Promise<void>` that resolves once the sync has fully torn down -
leaving the Supabase realtime channel and letting an in-flight change finish applying - instead of
only `void`. Calling it without awaiting behaves exactly as before: everything that can stop
synchronously still stops before the first `await`.

Never rejects: a failure while tearing down (for example the realtime channel could not be left) is
reported through the `error` event instead.

**Breaking:** the type of `unsubscribe()` changed from `(): void` to `(): Promise<void>`. Callers
that only invoked it are unaffected; a caller relying on its return type being `void` needs to update.
