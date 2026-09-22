/** Which side actually ended up hosting the database. */
export type WorkerTransport = 'shared-worker' | 'worker';

export interface WorkerFactories {
  /** Tried first. Build the SharedWorker at the call site so bundlers can see it. */
  shared: () => SharedWorker;
  /** Used when SharedWorker is missing or fails to start. */
  fallback: () => Worker;
}

export interface WorkerConnection<T> {
  transport: WorkerTransport;
  db: T;
}

/** A `Worker`-shaped facade over one `SharedWorker` client port. */
function portAsWorker(port: MessagePort): Worker {
  let started = false;

  const ensureStarted = () => {
    if (!started) {
      started = true;
      // Deferred to the first listener, so no message dispatched by the
      // SharedWorker before `PGliteWorker` is listening is ever dropped.
      port.start();
    }
  };

  return {
    addEventListener(...args: Parameters<MessagePort['addEventListener']>) {
      ensureStarted();
      port.addEventListener(...args);
    },
    removeEventListener(...args: Parameters<MessagePort['removeEventListener']>) {
      port.removeEventListener(...args);
    },
    postMessage(...args: Parameters<MessagePort['postMessage']>) {
      port.postMessage(...args);
    },
    terminate() {
      // Closes only this tab's port - the other tabs, and the shared
      // database, are unaffected.
      port.close();
    },
  } as unknown as Worker;
}

function rejectAfter(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;

  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for the SharedWorker after ${ms}ms`)),
      ms,
    );
  });

  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Connects through a `SharedWorker`, falling back to a dedicated `Worker`
 * when the shared transport is unavailable or fails to start in time.
 *
 * @param timeout Milliseconds allowed for the SharedWorker's script load and
 *   handshake, not for the database itself to finish booting.
 */
export async function connectWithFallback<T>(
  workers: WorkerFactories,
  connect: (worker: Worker) => Promise<T>,
  timeout: number,
): Promise<WorkerConnection<T>> {
  let sw: SharedWorker | undefined;

  try {
    // `workers.shared()` throws synchronously when `SharedWorker` is
    // undefined, so there is no separate feature test to do first.
    sw = workers.shared();

    const failed = new Promise<never>((_resolve, reject) => {
      sw?.addEventListener('error', () => reject(new Error('SharedWorker failed to load')), {
        once: true,
      });
    });

    const shim = portAsWorker(sw.port);
    const timedOut = rejectAfter(timeout);

    const db = await Promise.race([connect(shim), failed, timedOut.promise]).finally(() =>
      timedOut.cancel(),
    );

    return { transport: 'shared-worker', db };
  } catch {
    // Falling back is the point of this function - never rethrow here.
    sw?.port.close();
  }

  const worker = workers.fallback();

  return { transport: 'worker', db: await connect(worker) };
}
