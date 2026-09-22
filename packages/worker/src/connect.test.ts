import { describe, expect, test } from 'bun:test';

import { connectWithFallback, type WorkerFactories } from './connect.js';
import { settle } from './tests/async.js';

/**
 * Stands in for a `SharedWorker`: `port1` is exposed as `sw.port` (what the
 * shim in `connect.ts` wraps), `port2` stands in for the worker script's own
 * end of the connection.
 */
function createFakeSharedWorker() {
  const { port1, port2 } = new MessageChannel();

  // The worker side is not going through our shim, so it starts eagerly -
  // mirroring `createConnectHandler`, which calls `port.start()` the instant
  // a port connects.
  port2.start();

  const errorListeners = new Set<() => void>();
  let closed = false;
  const originalClose = port1.close.bind(port1);

  Object.assign(port1, {
    close() {
      closed = true;
      originalClose();
    },
  });

  const sw = {
    port: port1,
    addEventListener(type: string, listener: () => void) {
      if (type === 'error') {
        errorListeners.add(listener);
      }
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === 'error') {
        errorListeners.delete(listener);
      }
    },
  } as unknown as SharedWorker;

  return {
    sw,
    workerPort: port2,
    dispatchError: () => {
      for (const listener of errorListeners) {
        listener();
      }
    },
    isClosed: () => closed,
  };
}

describe('connectWithFallback', () => {
  test('returns shared-worker transport and the connected value when connect resolves', async () => {
    const { sw } = createFakeSharedWorker();
    const workers: WorkerFactories = {
      shared: () => sw,
      fallback: () => {
        throw new Error('should not fall back');
      },
    };

    const result = await connectWithFallback(workers, async () => 'connected-value', 1000);

    expect(result).toEqual({ transport: 'shared-worker', db: 'connected-value' });
  });

  test('relays postMessage to the worker port and preserves messages queued before listening', async () => {
    const { sw, workerPort } = createFakeSharedWorker();

    workerPort.addEventListener('message', (event) => {
      if ((event.data as { type: string }).type === 'init') {
        workerPort.postMessage({ type: 'ack' });
      }
    });

    // The `here` message a real SharedWorker sends the instant a client
    // connects - before `PGliteWorker`'s constructor has had a chance to add
    // its own listener a few ticks later.
    workerPort.postMessage({ type: 'here' });

    const workers: WorkerFactories = {
      shared: () => sw,
      fallback: () => {
        throw new Error('should not fall back');
      },
    };

    const received: unknown[] = [];

    await connectWithFallback(
      workers,
      async (worker) => {
        await settle();
        await settle();

        return new Promise<string>((resolve) => {
          worker.addEventListener('message', (event: MessageEvent) => {
            received.push(event.data);

            if ((event.data as { type: string }).type === 'ack') {
              resolve('ok');
            }
          });

          // Only dispatched to the worker port once a listener is attached
          // here too, so the round trip proves both directions relay.
          worker.postMessage({ type: 'init', options: {} });
        });
      },
      1000,
    );

    // The queued `here` arrives first, then the `ack` the worker port sent
    // back once it received `init` - proving both the deferred-start
    // delivery and the forwarding of `postMessage` to the worker port.
    expect(received).toEqual([{ type: 'here' }, { type: 'ack' }]);
  });

  test('falls back to the dedicated worker when the shared factory throws', async () => {
    const workers: WorkerFactories = {
      shared: () => {
        throw new Error('no SharedWorker');
      },
      fallback: () => 'fallback-worker' as unknown as Worker,
    };

    const result = await connectWithFallback(
      workers,
      async (worker) => (worker === ('fallback-worker' as unknown as Worker) ? 'ok' : 'wrong'),
      1000,
    );

    expect(result).toEqual({ transport: 'worker', db: 'ok' });
  });

  test('falls back and closes the port when the SharedWorker fails to load', async () => {
    const { sw, dispatchError, isClosed } = createFakeSharedWorker();
    const workers: WorkerFactories = {
      shared: () => sw,
      fallback: () => 'fallback-worker' as unknown as Worker,
    };

    const resultPromise = connectWithFallback(
      workers,
      async (worker) =>
        worker === ('fallback-worker' as unknown as Worker)
          ? 'ok'
          : // Never resolves for the shared attempt - only the error event settles it.
            new Promise<string>(() => {}),
      1000,
    );

    dispatchError();

    const result = await resultPromise;

    expect(result).toEqual({ transport: 'worker', db: 'ok' });
    expect(isClosed()).toBe(true);
  });

  test('falls back when connect never settles within the timeout', async () => {
    const { sw } = createFakeSharedWorker();
    const workers: WorkerFactories = {
      shared: () => sw,
      fallback: () => 'fallback-worker' as unknown as Worker,
    };

    const result = await connectWithFallback(
      workers,
      async (worker) =>
        worker === ('fallback-worker' as unknown as Worker) ? 'ok' : new Promise<string>(() => {}),
      20,
    );

    expect(result).toEqual({ transport: 'worker', db: 'ok' });
  });

  test('terminate() on the shim closes the port', async () => {
    const { sw, isClosed } = createFakeSharedWorker();
    const workers: WorkerFactories = {
      shared: () => sw,
      fallback: () => {
        throw new Error('should not fall back');
      },
    };

    await connectWithFallback(
      workers,
      async (worker) => {
        worker.terminate();
        return 'ok';
      },
      1000,
    );

    expect(isClosed()).toBe(true);
  });
});
