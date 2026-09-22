/**
 * The wire protocol identifiers `PGliteWorker` itself expects, keyed by the
 * `id` option the client sent. Both transports - the SharedWorker and
 * PGlite's own dedicated worker - use these same names, which is what lets a
 * client fall back from one to the other without the two ever colliding.
 */

/** The lock a leader-election-style worker holds for as long as it runs. */
export function electionLockId(id: string): string {
  return `pglite-election-lock:${id}`;
}

/** The broadcast channel every tab of a group listens on. */
export function broadcastChannelId(id: string): string {
  return `pglite-broadcast:${id}`;
}

/** The channel a single tab receives RPC responses and notifications on. */
export function tabChannelId(tabId: string): string {
  return `pglite-tab:${tabId}`;
}

/** Held by a tab for as long as it is open, so its worker side can detect closure. */
export function tabCloseLockId(tabId: string): string {
  return `pglite-tab-close:${tabId}`;
}

/** The slice of the Web Locks API this module needs. */
interface LockManager {
  request(name: string, callback: () => Promise<void>): Promise<void>;
}

/**
 * Resolves once the named lock is granted; the returned function releases it.
 *
 * PGlite's own worker helper, retyped so the release function is never
 * `undefined` - the promise inside `request`'s callback never resolves until
 * `release` has been captured.
 */
export function acquireLock(name: string): Promise<() => void> {
  const { navigator } = globalThis as { navigator: { locks: LockManager } };

  return new Promise<() => void>((resolve) => {
    void navigator.locks.request(
      name,
      () =>
        new Promise<void>((release) => {
          resolve(release);
        }),
    );
  });
}
