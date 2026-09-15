import { describe, expect, test } from 'bun:test';

import {
  createLeadership,
  isLeaderAware,
  singleProcessLeadership,
  webLockLeadership,
  workerLeadership,
} from './leadership.js';
import { settle } from './tests/async.js';
import { createFakePGlite, createFakeWorkerPGlite } from './tests/pglite.js';
import { createFakeLockManager } from './tests/web-locks.js';

describe('isLeaderAware', () => {
  test('detects a PGliteWorker-like instance', () => {
    expect(isLeaderAware(createFakeWorkerPGlite())).toBe(true);
  });

  test('rejects a plain PGlite-like instance', () => {
    expect(isLeaderAware(createFakePGlite())).toBe(false);
  });
});

describe('workerLeadership', () => {
  test('acquires immediately when already the leader', () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });
    const signals: AbortSignal[] = [];

    workerLeadership(pg).subscribe((signal) => signals.push(signal));

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  test('waits for the leader-change event when it is not the leader', () => {
    const pg = createFakeWorkerPGlite();
    const signals: AbortSignal[] = [];

    workerLeadership(pg).subscribe((signal) => signals.push(signal));

    expect(signals).toHaveLength(0);

    pg.setLeader(true);

    expect(signals).toHaveLength(1);
  });

  test('aborts the signal when leadership is lost and hands out a fresh one later', () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });
    const signals: AbortSignal[] = [];

    workerLeadership(pg).subscribe((signal) => signals.push(signal));
    pg.setLeader(false);

    expect(signals[0]?.aborted).toBe(true);

    pg.setLeader(true);

    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  test('ignores leader-change events that do not change leadership', () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });
    const signals: AbortSignal[] = [];

    workerLeadership(pg).subscribe((signal) => signals.push(signal));
    pg.setLeader(true);
    pg.setLeader(true);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  test('releasing aborts the signal and detaches the listener', () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });
    const signals: AbortSignal[] = [];

    const release = workerLeadership(pg).subscribe((signal) => signals.push(signal));

    expect(pg.leaderListeners).toBe(1);

    release();

    expect(signals[0]?.aborted).toBe(true);
    expect(pg.leaderListeners).toBe(0);
  });
});

describe('webLockLeadership', () => {
  test('acquires once the lock is granted, under a scoped name', async () => {
    const locks = createFakeLockManager();
    const signals: AbortSignal[] = [];

    webLockLeadership(locks, 'supapower:outgoing:app').subscribe((signal) => signals.push(signal));

    expect(locks.requested).toEqual(['supapower:outgoing:app']);
    expect(signals).toHaveLength(0);

    locks.grant();
    await settle();

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  test('releasing aborts the signal so the lock callback can resolve', async () => {
    const locks = createFakeLockManager();
    const signals: AbortSignal[] = [];

    const release = webLockLeadership(locks, 'lock').subscribe((signal) => signals.push(signal));

    locks.grant();
    await settle();
    release();

    expect(signals[0]?.aborted).toBe(true);
  });

  test('releasing while still queued never acquires and swallows the abort', async () => {
    const locks = createFakeLockManager();
    const signals: AbortSignal[] = [];

    const release = webLockLeadership(locks, 'lock').subscribe((signal) => signals.push(signal));

    release();
    locks.grant();
    await settle();

    expect(signals).toHaveLength(0);
  });
});

describe('singleProcessLeadership', () => {
  test('acquires immediately and releases on demand', () => {
    const signals: AbortSignal[] = [];

    const release = singleProcessLeadership().subscribe((signal) => signals.push(signal));

    expect(signals[0]?.aborted).toBe(false);

    release();

    expect(signals[0]?.aborted).toBe(true);
  });
});

describe('createLeadership', () => {
  test('prefers the PGliteWorker leader election', () => {
    expect(createLeadership(createFakeWorkerPGlite(), 'app').strategy).toBe('worker-leader');
  });

  test('falls back to a named Web Lock when one is available', () => {
    const navigator = globalThis.navigator as { locks?: unknown };
    const locks = createFakeLockManager();

    navigator.locks = locks;

    try {
      const leadership = createLeadership(createFakePGlite(), 'app');

      expect(leadership.strategy).toBe('web-lock');

      leadership.subscribe(() => {});

      expect(locks.requested).toEqual(['supapower:outgoing:app']);
    } finally {
      delete navigator.locks;
    }
  });

  test('assumes a single process when there is no Web Locks API', () => {
    expect(createLeadership(createFakePGlite(), 'app').strategy).toBe('single-process');
  });
});
