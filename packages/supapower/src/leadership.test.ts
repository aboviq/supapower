import { describe, expect, test } from 'bun:test';

import {
  createLeadership,
  singleProcessLeadership,
  visibleTabLeadership,
  webLockLeadership,
} from './leadership.js';
import { settle } from './tests/async.js';
import { createFakeDocument } from './tests/visibility.js';
import { createFakeLockManager } from './tests/web-locks.js';

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

describe('visibleTabLeadership', () => {
  test('a hidden tab requests no lock until it becomes visible', async () => {
    const locks = createFakeLockManager();
    const document = createFakeDocument('hidden');
    const signals: AbortSignal[] = [];

    visibleTabLeadership(locks, 'supapower:outgoing:app', document).subscribe((signal) =>
      signals.push(signal),
    );

    expect(locks.requested).toEqual([]);

    document.set('visible');

    expect(locks.requested).toEqual(['supapower:outgoing:app']);

    locks.grant();
    await settle();

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  test('hiding the tab aborts the signal and releases the lock', async () => {
    const locks = createFakeLockManager();
    const document = createFakeDocument('visible');
    const signals: AbortSignal[] = [];

    visibleTabLeadership(locks, 'lock', document).subscribe((signal) => signals.push(signal));

    locks.grant();
    await settle();

    expect(locks.held).toBe(true);

    document.set('hidden');
    await settle();

    expect(signals[0]?.aborted).toBe(true);
    expect(locks.held).toBe(false);
  });

  test('becoming visible again requests the lock afresh and hands out a new signal', async () => {
    const locks = createFakeLockManager();
    const document = createFakeDocument('visible');
    const signals: AbortSignal[] = [];

    visibleTabLeadership(locks, 'lock', document).subscribe((signal) => signals.push(signal));

    locks.grant();
    await settle();
    document.set('hidden');
    await settle();
    document.set('visible');

    expect(locks.requested).toEqual(['lock', 'lock']);

    locks.grant();
    await settle();

    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  test('releasing aborts the signal and detaches the visibility listener', async () => {
    const locks = createFakeLockManager();
    const document = createFakeDocument('visible');
    const signals: AbortSignal[] = [];

    const release = visibleTabLeadership(locks, 'lock', document).subscribe((signal) =>
      signals.push(signal),
    );

    locks.grant();
    await settle();

    expect(document.listeners).toBe(1);

    release();
    await settle();

    expect(signals[0]?.aborted).toBe(true);
    expect(document.listeners).toBe(0);
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
  test('prefers visible-tab coordination when both a document and Web Locks are available', () => {
    const navigator = globalThis.navigator as { locks?: unknown };
    const document = globalThis as { document?: unknown };
    const locks = createFakeLockManager();

    navigator.locks = locks;
    document.document = createFakeDocument();

    try {
      const leadership = createLeadership('app');

      expect(leadership.strategy).toBe('visible-tab');

      leadership.subscribe(() => {});

      expect(locks.requested).toEqual(['supapower:outgoing:app']);
    } finally {
      delete navigator.locks;
      delete document.document;
    }
  });

  test('falls back to a plain Web Lock without a document', () => {
    const navigator = globalThis.navigator as { locks?: unknown };
    const locks = createFakeLockManager();

    navigator.locks = locks;

    try {
      expect(createLeadership('app').strategy).toBe('web-lock');
    } finally {
      delete navigator.locks;
    }
  });

  test('assumes a single process when there is no Web Locks API', () => {
    expect(createLeadership('app').strategy).toBe('single-process');
  });
});
