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
 * - `visible-tab` - a named lock of our own via the Web Locks API, competed
 *   for only while the tab is visible. Every tab reaches the shared database
 *   through the same worker or files regardless of who leads, so leadership
 *   is free to follow visibility instead of database ownership. Hidden tabs
 *   get their timers throttled or frozen by the browser, so a hidden leader
 *   would stall the queue for every tab.
 * - `web-lock` - the same named lock, held unconditionally, used in a browser
 *   context without a `document` (e.g. a worker) where visibility does not
 *   apply.
 * - `single-process` - no coordination, for runtimes without the Web Locks API
 *   (Node, Bun, Deno) where a second process opening the same directory is not
 *   something this package can detect.
 */
export type LeadershipStrategy = 'visible-tab' | 'web-lock' | 'single-process';

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
 * The slice of `document` this module needs.
 *
 * Declared locally because the package has to typecheck without the DOM lib.
 */
interface VisibilityDocument {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

function getLockManager(): LockManager | undefined {
  const { navigator } = globalThis as { navigator?: { locks?: LockManager } };

  return typeof navigator?.locks?.request === 'function' ? navigator.locks : undefined;
}

function getDocument(): VisibilityDocument | undefined {
  const { document } = globalThis as { document?: VisibilityDocument };

  return typeof document?.addEventListener === 'function'
    && typeof document.visibilityState === 'string'
    ? document
    : undefined;
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

/**
 * Competes for the outgoing lock only while the tab is visible.
 *
 * Hidden tabs get their timers throttled or frozen by the browser, so a hidden
 * leader stalls the queue for every tab. Leadership is given up the moment the
 * tab is hidden - immediately, never on a timer, because a frozen timer would
 * hold the lock and block the tab the user is actually looking at.
 */
export function visibleTabLeadership(
  locks: LockManager,
  name: string,
  document: VisibilityDocument,
): Leadership {
  return {
    strategy: 'visible-tab',
    subscribe(onAcquired) {
      const inner = webLockLeadership(locks, name);
      let release: (() => void) | undefined;

      const update = () => {
        if (document.visibilityState === 'visible') {
          release ??= inner.subscribe(onAcquired);
        } else {
          release?.();
          release = undefined;
        }
      };

      document.addEventListener('visibilitychange', update);
      update();

      return () => {
        document.removeEventListener('visibilitychange', update);
        release?.();
        release = undefined;
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
 * @param scope Identifies the database being synced, so two apps on the same
 *   origin do not compete for one lock. Used by both browser strategies.
 */
export function createLeadership(scope: string): Leadership {
  const locks = getLockManager();

  if (!locks) {
    return singleProcessLeadership();
  }

  const name = `supapower:outgoing:${scope}`;
  const document = getDocument();

  return document ? visibleTabLeadership(locks, name, document) : webLockLeadership(locks, name);
}
