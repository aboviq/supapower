/**
 * Cross-process coordination for the outgoing sync.
 *
 * Every tab or process that opens the same PGlite database shares one set of
 * files, so the queue in `supapower.changes` is shared too. Exactly one of them
 * may drain it, otherwise the same batch is pushed twice.
 *
 * The lock cannot live in Postgres. PGlite is a single-connection engine and
 * every tab runs its own instance, so `pg_advisory_lock()` is invisible to the
 * other tabs and would block the only connection this one has. It has to be a
 * browser level lock instead, and this module picks the best one available.
 */

/**
 * The strategy a {@link Leadership} uses to decide who drains the queue.
 *
 * - `worker-leader` - `PGliteWorker`'s own leader election, which is the tab
 *   that actually hosts the database. Preferred, because it is the same
 *   election that decides who owns the files.
 * - `web-lock` - a named lock of our own via the Web Locks API, used when the
 *   database is a plain `PGlite` instance in a browser. Note that running a
 *   plain `PGlite` against the same `dataDir` in several tabs risks corrupting
 *   the database whatever this lock does; use `PGliteWorker` instead.
 * - `single-process` - no coordination, for runtimes without the Web Locks API
 *   (Node, Bun, Deno) where a second process opening the same directory is not
 *   something this package can detect.
 */
export type LeadershipStrategy = 'worker-leader' | 'web-lock' | 'single-process';

/**
 * Called every time leadership is acquired.
 *
 * The signal is aborted as soon as leadership is lost or released, so the work
 * started here must stop when it fires. It is called again, with a fresh
 * signal, if leadership is acquired once more.
 */
export type OnLeadershipAcquired = (signal: AbortSignal) => void;

export interface Leadership {
  /** Which coordination mechanism is in use, for diagnostics. */
  readonly strategy: LeadershipStrategy;

  /**
   * Starts competing for leadership.
   *
   * @param onAcquired Called with a signal that lives exactly as long as this
   *   process holds leadership.
   * @returns A function that gives up leadership and aborts the signal handed
   *   to `onAcquired`. Safe to call more than once.
   */
  subscribe(onAcquired: OnLeadershipAcquired): () => void;
}

/**
 * The part of `PGliteWorker` that tells us about leader election.
 *
 * Typed structurally so this package does not have to import
 * `@electric-sql/pglite/worker`, which cannot be loaded outside a browser.
 */
export interface LeaderAware {
  readonly isLeader: boolean;
  onLeaderChange(callback: () => void): () => void;
}

/**
 * The slice of the Web Locks API this module needs.
 *
 * Declared locally because the package has to typecheck without the DOM lib.
 */
interface LockManager {
  request(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void>;
}

/**
 * Whether the instance carries `PGliteWorker`'s leader election.
 *
 * PGlite hands extensions the `PGliteWorker` itself on the client side of a
 * worker, so the presence of `onLeaderChange` is what distinguishes a
 * worker-backed database from a plain one.
 */
export function isLeaderAware(pg: object): pg is LeaderAware {
  return (
    'onLeaderChange' in pg
    && typeof (pg as LeaderAware).onLeaderChange === 'function'
    && typeof (pg as LeaderAware).isLeader === 'boolean'
  );
}

function getLockManager(): LockManager | undefined {
  const { navigator } = globalThis as { navigator?: { locks?: LockManager } };

  return typeof navigator?.locks?.request === 'function' ? navigator.locks : undefined;
}

/** Follows `PGliteWorker`'s leader election. */
export function workerLeadership(pg: LeaderAware): Leadership {
  return {
    strategy: 'worker-leader',
    subscribe(onAcquired) {
      let held: AbortController | undefined;

      const update = () => {
        if (pg.isLeader) {
          if (held) {
            return; // already leading, `leader-change` fired for another reason
          }

          held = new AbortController();
          onAcquired(held.signal);

          return;
        }

        held?.abort();
        held = undefined;
      };

      const offLeaderChange = pg.onLeaderChange(update);

      update();

      return () => {
        offLeaderChange();
        held?.abort();
        held = undefined;
      };
    },
  };
}

/**
 * Holds a named exclusive lock for as long as this process is the leader.
 *
 * A Web Lock is released by the browser when the tab closes or crashes, so
 * there is no lease to expire and no window where two tabs both believe they
 * hold it. Tabs that lose the race queue up and take over automatically.
 */
export function webLockLeadership(locks: LockManager, name: string): Leadership {
  return {
    strategy: 'web-lock',
    subscribe(onAcquired) {
      const release = new AbortController();

      const granted = () =>
        new Promise<void>((resolve) => {
          if (release.signal.aborted) {
            resolve(); // released while we were still queued for the lock
            return;
          }

          const held = new AbortController();

          release.signal.addEventListener(
            'abort',
            () => {
              held.abort();
              resolve(); // resolving the callback is what releases the lock
            },
            { once: true },
          );

          onAcquired(held.signal);
        });

      void locks
        .request(name, { mode: 'exclusive', signal: release.signal }, granted)
        .catch((error: unknown) => {
          // Releasing before the lock was granted rejects the request. Anything
          // else is a real failure and must not be swallowed.
          if (!release.signal.aborted) {
            throw error;
          }
        });

      return () => {
        release.abort();
      };
    },
  };
}

/** Assumes this process is alone with the database. */
export function singleProcessLeadership(): Leadership {
  return {
    strategy: 'single-process',
    subscribe(onAcquired) {
      const held = new AbortController();

      onAcquired(held.signal);

      return () => {
        held.abort();
      };
    },
  };
}

/**
 * Picks the strongest coordination the current runtime offers.
 *
 * @param pg The database to coordinate around.
 * @param scope Identifies the database being synced, so two apps on the same
 *   origin do not compete for one lock. Only used by the `web-lock` strategy.
 */
export function createLeadership(pg: object, scope: string): Leadership {
  if (isLeaderAware(pg)) {
    return workerLeadership(pg);
  }

  const locks = getLockManager();

  return locks
    ? webLockLeadership(locks, `supapower:outgoing:${scope}`)
    : singleProcessLeadership();
}
