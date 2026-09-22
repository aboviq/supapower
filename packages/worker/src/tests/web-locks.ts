/**
 * A `navigator.locks` stand-in for the two-argument `request(name, callback)`
 * form `acquireLock` uses.
 *
 * Not shared with `supapower`'s own fake lock manager: that one drives the
 * three-argument signal form `webLockLeadership` uses, and the two packages
 * do not depend on each other.
 */
export interface FakeLockManager {
  /** Every lock name that has been requested, in order. */
  readonly requested: string[];
  request(name: string, callback: () => Promise<void> | void): Promise<void>;
  /** Grants the pending request for `name`, as the browser would once it is free. */
  grant(name: string): void;
}

export function createFakeLockManager(): FakeLockManager {
  const requested: string[] = [];
  const pending = new Map<string, () => void>();

  return {
    requested,
    request(name, callback) {
      requested.push(name);

      return new Promise<void>((resolve) => {
        pending.set(name, () => {
          pending.delete(name);
          void Promise.resolve(callback()).then(resolve);
        });
      });
    },
    grant(name) {
      pending.get(name)?.();
    },
  };
}
