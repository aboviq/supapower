import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { WorkerOptions } from '@electric-sql/pglite/worker';

import { broadcastChannelId, electionLockId, tabChannelId } from './protocol.js';
import { createConnectHandler } from './shared-worker.js';
import { settle, waitFor } from './tests/async.js';
import { createFakeLockManager, type FakeLockManager } from './tests/web-locks.js';

interface FakeDb {
  debug: number;
  close(): Promise<void>;
  exec(sql: string): Promise<void>;
  execProtocol(message: Uint8Array): Promise<{ messages: unknown[]; data: Uint8Array }>;
  execProtocolStream(message: Uint8Array): Promise<unknown[]>;
  execProtocolRawStream(message: Uint8Array, options: unknown): Promise<void>;
  execProtocolRaw(message: Uint8Array): Promise<Uint8Array>;
  dumpDataDir(compression?: unknown): Promise<Blob>;
  syncToFs(): Promise<void>;
  _handleBlob(blob?: unknown): Promise<void>;
  _getWrittenBlob(): Promise<undefined>;
  _cleanupBlob(): Promise<void>;
  _checkReady(): Promise<void>;
  _runExclusiveQuery<T>(fn: () => Promise<T>): Promise<T>;
  _runExclusiveTransaction<T>(fn: () => Promise<T>): Promise<T>;
  onNotification(callback: (channel: string, payload: string) => void): () => void;
  waitReady: Promise<void>;
  /** Not part of the real `PGlite` surface - fires the registered notification listeners. */
  notify(channel: string, payload: string): void;
}

function createFakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  const listeners = new Set<(channel: string, payload: string) => void>();

  return {
    debug: 0,
    waitReady: Promise.resolve(),
    async close() {},
    async exec() {},
    async execProtocol(message) {
      return { messages: [], data: message };
    },
    async execProtocolStream() {
      return [];
    },
    async execProtocolRawStream() {},
    async execProtocolRaw(message) {
      return message;
    },
    async dumpDataDir() {
      return new Blob();
    },
    async syncToFs() {},
    async _handleBlob() {},
    async _getWrittenBlob() {
      return undefined;
    },
    async _cleanupBlob() {},
    async _checkReady() {},
    async _runExclusiveQuery(fn) {
      return fn();
    },
    async _runExclusiveTransaction(fn) {
      return fn();
    },
    onNotification(callback) {
      listeners.add(callback);

      return () => listeners.delete(callback);
    },
    notify(channel, payload) {
      for (const listener of listeners) {
        listener(channel, payload);
      }
    },
    ...overrides,
  };
}

function workerOptions(
  init: (options: Parameters<WorkerOptions['init']>[0]) => Promise<FakeDb>,
): WorkerOptions {
  return { init: init as unknown as WorkerOptions['init'] };
}

describe('createConnectHandler', () => {
  let locks: FakeLockManager;
  let navigator: { locks?: FakeLockManager };

  beforeEach(() => {
    locks = createFakeLockManager();
    navigator = globalThis.navigator as unknown as { locks?: FakeLockManager };
    navigator.locks = locks;
  });

  afterEach(() => {
    delete navigator.locks;
  });

  test('sends here then ready with the client-supplied id', async () => {
    const handler = createConnectHandler(workerOptions(async () => createFakeDb()));
    const { port1, port2 } = new MessageChannel();
    const messages: unknown[] = [];

    let resolveReceived: () => void;
    const received = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });

    port2.addEventListener('message', (event) => {
      messages.push(event.data);

      if (messages.length === 2) {
        resolveReceived();
      }
    });
    port2.start();

    handler(port1);
    port2.postMessage({ type: 'init', options: { id: 'db-1' } });

    await received;

    expect(messages).toEqual([{ type: 'here' }, { type: 'ready', id: 'db-1' }]);
  });

  test('a port that connects after the database has booted still gets here then ready, and init runs once', async () => {
    let initCalls = 0;
    const handler = createConnectHandler(
      workerOptions(async () => {
        initCalls += 1;

        return createFakeDb();
      }),
    );

    const first = new MessageChannel();

    first.port2.start();
    handler(first.port1);
    first.port2.postMessage({ type: 'init', options: { id: 'db-2' } });

    expect(await waitFor(() => locks.requested.includes(electionLockId('db-2')))).toBe(true);
    locks.grant(electionLockId('db-2'));

    expect(await waitFor(() => initCalls === 1)).toBe(true);

    const second = new MessageChannel();
    const secondMessages: unknown[] = [];

    let resolveReady: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    second.port2.addEventListener('message', (event) => {
      secondMessages.push(event.data);

      if (secondMessages.length === 2) {
        resolveReady();
      }
    });
    second.port2.start();

    handler(second.port1);
    second.port2.postMessage({ type: 'init', options: { id: 'db-2' } });

    await ready;

    expect(secondMessages).toEqual([{ type: 'here' }, { type: 'ready', id: 'db-2' }]);
    expect(initCalls).toBe(1);
  });

  test('serves nothing until the election lock is granted, then starts', async () => {
    let initCalls = 0;
    const handler = createConnectHandler(
      workerOptions(async () => {
        initCalls += 1;

        return createFakeDb();
      }),
    );

    const broadcastMessages: unknown[] = [];
    const channel = new BroadcastChannel(broadcastChannelId('db-3'));

    channel.addEventListener('message', (event) => broadcastMessages.push(event.data));

    const { port1, port2 } = new MessageChannel();

    port2.start();
    handler(port1);
    port2.postMessage({ type: 'init', options: { id: 'db-3' } });

    await settle();
    await settle();

    expect(initCalls).toBe(0);
    expect(broadcastMessages).toEqual([]);

    locks.grant(electionLockId('db-3'));

    expect(await waitFor(() => initCalls === 1)).toBe(true);
    expect(
      await waitFor(() =>
        broadcastMessages.some((message) => (message as { type: string }).type === 'leader-here'),
      ),
    ).toBe(true);

    channel.close();
  });

  test('answers an rpc-call with rpc-return, and a throwing call with rpc-error', async () => {
    const db = createFakeDb({
      debug: 3,
      async syncToFs() {
        throw new Error('disk full');
      },
    });

    const handler = createConnectHandler(workerOptions(async () => db));

    const { port1, port2 } = new MessageChannel();

    port2.start();
    handler(port1);
    port2.postMessage({ type: 'init', options: { id: 'db-4' } });

    expect(await waitFor(() => locks.requested.includes(electionLockId('db-4')))).toBe(true);
    locks.grant(electionLockId('db-4'));

    const broadcast = new BroadcastChannel(broadcastChannelId('db-4'));
    const leaderMessages: unknown[] = [];

    broadcast.addEventListener('message', (event) => leaderMessages.push(event.data));

    expect(
      await waitFor(() =>
        leaderMessages.some((m) => (m as { type: string }).type === 'leader-here'),
      ),
    ).toBe(true);

    broadcast.postMessage({ type: 'tab-here', id: 'tab-1' });

    const tabChannel = new BroadcastChannel(tabChannelId('tab-1'));
    const tabMessages: unknown[] = [];

    tabChannel.addEventListener('message', (event) => tabMessages.push(event.data));

    expect(
      await waitFor(() => tabMessages.some((m) => (m as { type: string }).type === 'connected')),
    ).toBe(true);

    tabChannel.postMessage({
      type: 'rpc-call',
      callId: 'call-1',
      method: 'getDebugLevel',
      args: [],
    });

    expect(
      await waitFor(() => tabMessages.some((m) => (m as { type: string }).type === 'rpc-return')),
    ).toBe(true);
    expect(tabMessages).toContainEqual({ type: 'rpc-return', callId: 'call-1', result: 3 });

    tabChannel.postMessage({
      type: 'rpc-call',
      callId: 'call-2',
      method: 'syncToFs',
      args: [],
    });

    expect(
      await waitFor(() => tabMessages.some((m) => (m as { type: string }).type === 'rpc-error')),
    ).toBe(true);
    expect(tabMessages).toContainEqual({
      type: 'rpc-error',
      callId: 'call-2',
      error: { message: 'disk full' },
    });

    broadcast.close();
    tabChannel.close();
  });

  test('forwards db.onNotification output as a notify message on the broadcast channel', async () => {
    const db = createFakeDb();
    const handler = createConnectHandler(workerOptions(async () => db));

    const { port1, port2 } = new MessageChannel();

    port2.start();
    handler(port1);
    port2.postMessage({ type: 'init', options: { id: 'db-5' } });

    expect(await waitFor(() => locks.requested.includes(electionLockId('db-5')))).toBe(true);
    locks.grant(electionLockId('db-5'));

    const broadcast = new BroadcastChannel(broadcastChannelId('db-5'));
    const messages: unknown[] = [];

    broadcast.addEventListener('message', (event) => messages.push(event.data));

    expect(
      await waitFor(() => messages.some((m) => (m as { type: string }).type === 'leader-here')),
    ).toBe(true);

    db.notify('my-channel', 'payload');

    expect(
      await waitFor(() => messages.some((m) => (m as { type: string }).type === 'notify')),
    ).toBe(true);
    expect(messages).toContainEqual({ type: 'notify', channel: 'my-channel', payload: 'payload' });

    broadcast.close();
  });
});
