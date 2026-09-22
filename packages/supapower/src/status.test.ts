import { describe, expect, test } from 'bun:test';

import { SupapowerError } from './errors.js';
import { SupapowerErrorEvent } from './events.js';
import { createSupapower } from './index.js';
import { installLeadershipEnv } from './tests/leadership.js';
import { asPGlite, createFakePGlite } from './tests/pglite.js';
import { asSupabaseClient, createFakeSupabase } from './tests/supabase.js';

const idleSupabase = asSupabaseClient(createFakeSupabase());

describe('supapower.status', () => {
  test('starts idle', () => {
    const namespace = createSupapower(asPGlite(createFakePGlite()));

    expect(namespace.status).toEqual({
      leading: false,
      connected: false,
      connecting: false,
      downloading: false,
      uploading: false,
      hasSynced: false,
      lastSyncedAt: undefined,
      downloadError: undefined,
      uploadError: undefined,
    });
  });

  test('reports connecting while leading and not yet connected, then connected', async () => {
    const namespace = createSupapower(asPGlite(createFakePGlite()));
    const sync = await namespace.sync({ supabase: idleSupabase, tables: [] });

    expect(namespace.status.leading).toBe(true);
    expect(namespace.status.connecting).toBe(true);
    expect(namespace.status.connected).toBe(false);

    namespace.events.dispatchEvent(new Event('connect'));

    expect(namespace.status.connected).toBe(true);
    expect(namespace.status.connecting).toBe(false);

    await sync.unsubscribe();
  });

  test('a follower tab never reports leading or connecting', async () => {
    const env = installLeadershipEnv();
    const namespace = createSupapower(asPGlite(createFakePGlite()));
    const sync = await namespace.sync({ supabase: idleSupabase, tables: [] });

    expect(namespace.status.leading).toBe(false);
    expect(namespace.status.connecting).toBe(false);

    await sync.unsubscribe();
    env.restore();
  });

  test('tracks a download in progress', () => {
    const namespace = createSupapower(asPGlite(createFakePGlite()));

    namespace.events.dispatchEvent(new Event('downloadStart'));
    expect(namespace.status.downloading).toBe(true);

    namespace.events.dispatchEvent(new Event('downloadFinish'));
    expect(namespace.status.downloading).toBe(false);
    expect(namespace.status.hasSynced).toBe(true);
    expect(namespace.status.lastSyncedAt).toBeInstanceOf(Date);
  });

  test('tracks an upload in progress', () => {
    const namespace = createSupapower(asPGlite(createFakePGlite()));

    namespace.events.dispatchEvent(new Event('uploadStart'));
    expect(namespace.status.uploading).toBe(true);

    namespace.events.dispatchEvent(new Event('uploadFinish'));
    expect(namespace.status.uploading).toBe(false);
  });

  test('a download failure clears downloading and records the error, a later finish clears it', () => {
    const namespace = createSupapower(asPGlite(createFakePGlite()));
    const error = new SupapowerError('offline', { code: 'download_failed' });

    namespace.events.dispatchEvent(new Event('downloadStart'));
    namespace.events.dispatchEvent(new SupapowerErrorEvent(error));

    expect(namespace.status.downloading).toBe(false);
    expect(namespace.status.downloadError).toBe(error);

    namespace.events.dispatchEvent(new Event('downloadFinish'));
    expect(namespace.status.downloadError).toBeUndefined();
  });

  test('an upload failure clears uploading and records the error, a later finish clears it', () => {
    const namespace = createSupapower(asPGlite(createFakePGlite()));
    const error = new SupapowerError('rejected', { code: 'upload_failed' });

    namespace.events.dispatchEvent(new Event('uploadStart'));
    namespace.events.dispatchEvent(new SupapowerErrorEvent(error));

    expect(namespace.status.uploading).toBe(false);
    expect(namespace.status.uploadError).toBe(error);

    namespace.events.dispatchEvent(new Event('uploadFinish'));
    expect(namespace.status.uploadError).toBeUndefined();
  });

  test('an advisory error does not change the status or fire statusChange', () => {
    const namespace = createSupapower(asPGlite(createFakePGlite()));
    const before = namespace.status;
    let fired = 0;

    namespace.events.addEventListener('statusChange', () => {
      fired += 1;
    });

    namespace.events.dispatchEvent(
      new SupapowerErrorEvent(new SupapowerError('no such row', { code: 'delete_ignored' })),
    );

    expect(namespace.status).toBe(before);
    expect(fired).toBe(0);
  });

  test('the snapshot is a stable reference until something changes', () => {
    const namespace = createSupapower(asPGlite(createFakePGlite()));
    const before = namespace.status;

    expect(namespace.status).toBe(before);

    namespace.events.dispatchEvent(new Event('downloadStart'));

    expect(namespace.status).not.toBe(before);
  });

  test('unsubscribe clears the in-flight flags but keeps sync history', async () => {
    const namespace = createSupapower(asPGlite(createFakePGlite()));
    const sync = await namespace.sync({ supabase: idleSupabase, tables: [] });

    namespace.events.dispatchEvent(new Event('downloadFinish'));

    await sync.unsubscribe();

    expect(namespace.status.leading).toBe(false);
    expect(namespace.status.connecting).toBe(false);
    expect(namespace.status.connected).toBe(false);
    expect(namespace.status.downloading).toBe(false);
    expect(namespace.status.uploading).toBe(false);
    expect(namespace.status.hasSynced).toBe(true);
    expect(namespace.status.lastSyncedAt).toBeInstanceOf(Date);
  });
});
