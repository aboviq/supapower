---
'supapower': minor
---

Notice a `DELETE` that Supabase quietly ignored, and add `onError`.

Row-level security refuses a delete by filtering the row out of the policy's `USING` clause rather
than raising, so a denied `DELETE` came back as an ordinary success that removed nothing - and the
change was committed as synced while the row sat untouched upstream. The delete now asks PostgREST to
count what it removed and reports a definite zero.

It is reported rather than thrown: a batch re-sent after a crash legitimately deletes nothing the
second time, and failing there would wedge the queue on a change that can never succeed again. The
two cases cannot be told apart from the client, so `delete_ignored` means either the row was already
gone or the delete was refused.

Reporting it needed somewhere to report to, so `SupapowerSyncOptions` takes an `onError`. It receives
everything that went wrong without stopping the sync - a retried upload or download, a realtime
channel in trouble, a change that could not be applied locally, and the ignored deletes. All of that
used to pass silently with no way to observe it.
