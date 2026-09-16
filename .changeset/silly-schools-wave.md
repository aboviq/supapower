---
'supapower': minor
---

Wait for the auth client before syncing anything, in either direction.

The outgoing queue used to start draining the moment a tab won leadership, before anything was known
about who was signed in. Both directions now start from the first `onAuthStateChange` notification,
which supabase-js queues until its own initialization has settled and therefore doubles as an
"authentication is ready" signal, session or no session.

The HTTP requests were never the race - supabase-js resolves the token per request and that blocks on
the same initialization - but a queue drained before the session is known is drained with whatever
token happens to exist. After a reload with an expired refresh token that is the anon key, and every
change to an `authenticated` table comes back as a row-level security denial, which the outgoing loop
treats as unrecoverable and discards.

The outgoing queue is now also filtered by what the current user can reach: changes to tables a
signed out client has no session for stay queued instead of being pushed anonymously. A local
transaction touching both reachable and unreachable tables only has the pushed half removed from the
queue.

Both directions share one abort signal per identity, so signing out stops an upload in flight rather
than letting it finish as the wrong user.
