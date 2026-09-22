/** The slice of `navigator.locks` that {@link createFakeLockManager} stands in for. */
export interface FakeLockManager {
  /** Every lock name that has been requested, in order. */
  readonly requested: string[];
  /** Whether the lock is currently granted and not yet released. */
  readonly held: boolean;
  request(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void>;
  /** Grants the pending request, as the browser would once the lock is free. */
  grant(): void;
}

/**
 * A `navigator.locks` stand-in that hands out the lock only when the test says
 * so, which is what makes the queued-but-not-yet-granted state observable.
 */
export function createFakeLockManager(): FakeLockManager {
  const requested: string[] = [];
  let pending: (() => void) | undefined;
  let held = false;

  return {
    requested,
    get held() {
      return held;
    },
    async request(name, options, callback) {
      requested.push(name);

      await new Promise<void>((resolve, reject) => {
        pending = resolve;

        options.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });

      pending = undefined;
      held = true;

      try {
        await callback();
      } finally {
        held = false;
      }
    },
    grant() {
      pending?.();
    },
  };
}
