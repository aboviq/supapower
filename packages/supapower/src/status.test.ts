import { describe, expect, test } from 'bun:test';

import { createInitialSyncStatus, isBusy } from './status.js';

describe('createInitialSyncStatus', () => {
  test('starts disconnected and never synced', () => {
    expect(createInitialSyncStatus()).toEqual({
      connected: false,
      hasSynced: false,
      uploading: false,
      downloading: false,
      lastSyncedAt: null,
    });
  });

  test('returns a fresh object every call', () => {
    expect(createInitialSyncStatus()).not.toBe(createInitialSyncStatus());
  });
});

describe('isBusy', () => {
  test('is false when idle', () => {
    expect(isBusy(createInitialSyncStatus())).toBe(false);
  });

  test('is true while uploading or downloading', () => {
    const status = createInitialSyncStatus();

    expect(isBusy({ ...status, uploading: true })).toBe(true);
    expect(isBusy({ ...status, downloading: true })).toBe(true);
  });
});
