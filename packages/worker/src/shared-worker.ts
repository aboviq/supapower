/**
 * The SharedWorker side of a multi-tab PGlite database: one instance serves
 * every tab of one browser context, so the database is never owned by a
 * particular tab and is never handed over when one closes.
 *
 * `connectTab` and `makeWorkerApi` below are derived from
 * `@electric-sql/pglite`'s `packages/pglite/src/worker/index.ts`
 * (Apache-2.0, copyright ElectricSQL) and have been modified to use this
 * package's id helpers. Everything else - the per-port handshake in
 * {@link createConnectHandler} and {@link sharedWorker} - is new: it
 * replaces upstream's `postMessage`-based single-client handshake and
 * leader election, neither of which apply here since exactly one
 * SharedWorker already exists per origin and database id.
 */

import type { PGlite } from '@electric-sql/pglite';
import type { WorkerOptions } from '@electric-sql/pglite/worker';

import {
  acquireLock,
  broadcastChannelId,
  electionLockId,
  tabChannelId,
  tabCloseLockId,
} from './protocol.js';

type InitOptions = Parameters<WorkerOptions['init']>[0];

function connectTab(tabId: string, pg: PGlite, connectedTabs: Set<string>): void {
  if (connectedTabs.has(tabId)) {
    return;
  }

  connectedTabs.add(tabId);

  const tabChannel = new BroadcastChannel(tabChannelId(tabId));

  // The tab-close lock is held by the client for as long as it is open, so
  // it becomes available the moment the tab (or its `PGliteWorker`) closes.
  // oxlint-disable-next-line promise/always-return -- fire-and-forget cleanup, nothing to chain onto.
  void acquireLock(tabCloseLockId(tabId)).then(() => {
    tabChannel.close();
    connectedTabs.delete(tabId);
  });

  const api = makeWorkerApi(tabId, pg);

  tabChannel.addEventListener('message', async (event) => {
    const msg = event.data;

    if (msg.type !== 'rpc-call') {
      return;
    }

    await pg.waitReady;

    const { callId, method, args } = msg as WorkerRpcCall<WorkerRpcMethod>;

    try {
      // @ts-ignore no apparent reason why it fails
      const result = (await api[method](...args)) as WorkerRpcResult<typeof method>['result'];

      tabChannel.postMessage({
        type: 'rpc-return',
        callId,
        result,
      } satisfies WorkerRpcResult<typeof method>);
    } catch (error) {
      // oxlint-disable-next-line no-console
      console.error(error);
      tabChannel.postMessage({
        type: 'rpc-error',
        callId,
        error: { message: (error as Error).message },
      } satisfies WorkerRpcError);
    }
  });

  // Send a message to the tab to let it know it's connected
  tabChannel.postMessage({ type: 'connected' });
}

function makeWorkerApi(tabId: string, db: PGlite) {
  let queryLockRelease: (() => void) | null = null;
  let transactionLockRelease: (() => void) | null = null;

  // If the tab is closed while it is holding a lock, release the locks and
  // roll back any pending transaction.
  // oxlint-disable-next-line promise/always-return -- fire-and-forget cleanup, nothing to chain onto.
  void acquireLock(tabCloseLockId(tabId)).then(() => {
    if (transactionLockRelease) {
      void db.exec('ROLLBACK');
    }

    queryLockRelease?.();
    transactionLockRelease?.();
  });

  return {
    async getDebugLevel() {
      return db.debug;
    },
    async close() {
      await db.close();
    },
    async execProtocol(message: Uint8Array) {
      const { messages, data } = await db.execProtocol(message);

      if (data.byteLength !== data.buffer.byteLength) {
        const buffer = new ArrayBuffer(data.byteLength);
        const dataCopy = new Uint8Array(buffer);

        dataCopy.set(data);

        return { messages, data: dataCopy };
      }

      return { messages, data };
    },
    async execProtocolStream(message: Uint8Array) {
      return await db.execProtocolStream(message);
    },
    async execProtocolRawStream(
      message: Uint8Array,
      options: Parameters<PGlite['execProtocolRawStream']>[1],
    ) {
      return await db.execProtocolRawStream(message, options);
    },
    async execProtocolRaw(message: Uint8Array) {
      const result = await db.execProtocolRaw(message);

      if (result.byteLength !== result.buffer.byteLength) {
        // The data is a slice of a larger buffer, potentially the whole
        // memory of the WASM module - copy it out before it is sent.
        const buffer = new ArrayBuffer(result.byteLength);
        const resultCopy = new Uint8Array(buffer);

        resultCopy.set(result);

        return resultCopy;
      }

      return result;
    },
    async dumpDataDir(compression?: Parameters<PGlite['dumpDataDir']>[0]) {
      return await db.dumpDataDir(compression);
    },
    async syncToFs() {
      return await db.syncToFs();
    },
    // oxlint-disable-next-line no-underscore-dangle -- PGlite's own method name.
    async _handleBlob(blob?: File | Blob) {
      // oxlint-disable-next-line no-underscore-dangle -- PGlite's own method name.
      return await db._handleBlob(blob);
    },
    // oxlint-disable-next-line no-underscore-dangle -- PGlite's own method name.
    async _getWrittenBlob() {
      // oxlint-disable-next-line no-underscore-dangle -- PGlite's own method name.
      return await db._getWrittenBlob();
    },
    // oxlint-disable-next-line no-underscore-dangle -- PGlite's own method name.
    async _cleanupBlob() {
      // oxlint-disable-next-line no-underscore-dangle -- PGlite's own method name.
      return await db._cleanupBlob();
    },
    // oxlint-disable-next-line no-underscore-dangle -- PGlite's own method name.
    async _checkReady() {
      // oxlint-disable-next-line no-underscore-dangle -- PGlite's own method name.
      return await db._checkReady();
    },
    async _acquireQueryLock() {
      return new Promise<void>((resolve) => {
        // oxlint-disable-next-line no-underscore-dangle -- PGlite's own method name.
        void db._runExclusiveQuery(
          () =>
            new Promise<void>((release) => {
              queryLockRelease = release;
              resolve();
            }),
        );
      });
    },
    async _releaseQueryLock() {
      queryLockRelease?.();
      queryLockRelease = null;
    },
    async _acquireTransactionLock() {
      return new Promise<void>((resolve) => {
        // oxlint-disable-next-line no-underscore-dangle -- PGlite's own method name.
        void db._runExclusiveTransaction(
          () =>
            new Promise<void>((release) => {
              transactionLockRelease = release;
              resolve();
            }),
        );
      });
    },
    async _releaseTransactionLock() {
      transactionLockRelease?.();
      transactionLockRelease = null;
    },
  };
}

type WorkerApi = ReturnType<typeof makeWorkerApi>;

type WorkerRpcMethod = keyof WorkerApi;

interface WorkerRpcCall<Method extends WorkerRpcMethod> {
  type: 'rpc-call';
  callId: string;
  method: Method;
  args: Parameters<WorkerApi[Method]>;
}

interface WorkerRpcResult<Method extends WorkerRpcMethod> {
  type: 'rpc-return';
  callId: string;
  result: Awaited<ReturnType<WorkerApi[Method]>>;
}

interface WorkerRpcError {
  type: 'rpc-error';
  callId: string;
  error: { message: string };
}

/**
 * The slice of `SharedWorkerGlobalScope` this module needs.
 *
 * Declared locally because `SharedWorkerGlobalScope` is not part of the DOM
 * lib - detect it at runtime with `'SharedWorkerGlobalScope' in globalThis`.
 */
interface SharedWorkerScope {
  onconnect: ((event: MessageEvent) => void) | null;
  location: { href: string };
}

/**
 * Builds the per-port connection handler for one database group.
 *
 * The database boots once, on the first port to send `init`; every port -
 * including ones that connect long after that - gets `here` then `ready`.
 */
export function createConnectHandler(options: WorkerOptions): (port: MessagePort) => void {
  const scope = globalThis as unknown as SharedWorkerScope;

  let idResolve!: (id: string) => void;
  const idPromise = new Promise<string>((resolve) => {
    idResolve = resolve;
  });

  let started = false;
  let dbPromise: Promise<PGlite> | undefined;
  const connectedTabs = new Set<string>();

  const start = async (id: string, initOptions: InitOptions): Promise<void> => {
    // Guards the case where a tab already fell back to a dedicated worker
    // and owns this database: this worker then simply waits here forever,
    // while its own clients still reach the real owner over the broadcast
    // channel, because both transports speak the same protocol under the
    // same ids.
    await acquireLock(electionLockId(id));

    dbPromise = options.init(initOptions);

    const channel = new BroadcastChannel(broadcastChannelId(id));

    channel.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'tab-here') {
        void dbPromise?.then((db) => connectTab(msg.id as string, db, connectedTabs));
      }
    });

    // Tabs left over from a previous worker generation reset and re-announce
    // themselves - `PGliteWorker` re-sends `tab-here` every 16ms until it is
    // connected - so this goes out before the database has finished booting.
    channel.postMessage({ type: 'leader-here', id });

    const db = await dbPromise;

    db.onNotification((notifyChannel, payload) => {
      channel.postMessage({ type: 'notify', channel: notifyChannel, payload });
    });
  };

  return (port: MessagePort): void => {
    port.start();
    port.postMessage({ type: 'here' });

    let initialized = false;

    port.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type !== 'init' || initialized) {
        return;
      }

      initialized = true;

      if (!started) {
        started = true;

        const initOptions = msg.options as InitOptions;
        const id = initOptions.id ?? `${scope.location.href}:${initOptions.dataDir ?? ''}`;

        idResolve(id);
        void start(id, initOptions);
      }

      // oxlint-disable-next-line promise/always-return -- fire-and-forget reply, nothing to chain onto.
      void idPromise.then((id) => {
        port.postMessage({ type: 'ready', id });
      });
    });
  };
}

/** Runs a `WorkerOptions.init`-configured PGlite database as a SharedWorker. */
export function sharedWorker(options: WorkerOptions): void {
  const scope = globalThis as unknown as SharedWorkerScope;
  const handleConnect = createConnectHandler(options);

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the standard SharedWorker handshake API.
  scope.onconnect = (event) => {
    const port = (event as MessageEvent & { ports: MessagePort[] }).ports[0];

    if (port) {
      handleConnect(port);
    }
  };
}
