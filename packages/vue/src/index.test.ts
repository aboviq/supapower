import { describe, expect, test } from 'bun:test';

import { createSupapowerEvents } from 'supapower/events';
import type { SupapowerStatus } from 'supapower/types';
import { effectScope } from 'vue';

import { useSupapowerStatus, type PGliteWithLiveAndSupapower } from './index.js';

const INITIAL: SupapowerStatus = {
  leading: false,
  connected: false,
  connecting: false,
  downloading: false,
  uploading: false,
  hasSynced: false,
  lastSyncedAt: undefined,
  downloadError: undefined,
  uploadError: undefined,
};

function fakeDb() {
  const events = createSupapowerEvents();
  let status = INITIAL;

  return {
    events,
    set(next: Partial<SupapowerStatus>) {
      status = { ...status, ...next };
      events.dispatchEvent(new Event('statusChange'));
    },
    db: {
      supapower: {
        events,
        get status() {
          return status;
        },
      },
    } as unknown as PGliteWithLiveAndSupapower,
  };
}

describe('useSupapowerStatus', () => {
  test('follows statusChange and stops with the effect scope', () => {
    const { db, set } = fakeDb();
    const scope = effectScope();
    const status = scope.run(() => useSupapowerStatus(db))!;

    expect(status.connected.value).toBe(false);

    set({ leading: true, connected: true, hasSynced: true });
    expect(status.connected.value).toBe(true);
    expect(status.hasSynced.value).toBe(true);

    scope.stop();
    set({ connected: false });
    expect(status.connected.value).toBe(true);
  });
});
