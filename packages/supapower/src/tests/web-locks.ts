/** The slice of `navigator.locks` that {@link createFakeLockManager} stands in for. */
export interface FakeLockManager {
  /** Every lock name that has been requested, in order. */
  readonly requested: string[];
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

  return {
    requested,
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

      await callback();
    },
    grant() {
      pending?.();
    },
  };
}
