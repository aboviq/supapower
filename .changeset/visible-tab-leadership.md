---
'supapower': minor
---

Outgoing-sync leadership no longer follows which tab hosts the PGlite database (`'worker-leader'`); it now follows tab visibility (`'visible-tab'`) instead, since a hidden tab's timers get throttled by the browser and would stall the queue for every tab. `createLeadership()` no longer takes a `pg` argument, and `isLeaderAware`, `workerLeadership`, and `LeaderAware` have been removed from `supapower/leadership`.
