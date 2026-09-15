import { describe, expect, test } from 'bun:test';

import { createSupapower } from './index.js';
import { settle } from './tests/async.js';
import {
  asPGlite,
  createFakePGlite,
  createFakeWorkerPGlite,
  type FakePGlite,
} from './tests/pglite.js';
import { asSupabaseClient, createFakeSupabase } from './tests/supabase.js';

const supabase = asSupabaseClient(createFakeSupabase());

const ran = (pg: FakePGlite, fragment: string) =>
  pg.statements.some((statement) => statement.includes(fragment));

describe('createSupapower().sync', () => {
  test('sets up the schema and starts draining the queue', async () => {
    const pg = createFakePGlite();

    const sync = await createSupapower(asPGlite(pg)).sync({ supabase, tables: ['todos'] });

    await settle();

    expect(ran(pg, 'CREATE SCHEMA IF NOT EXISTS supapower')).toBe(true);
    expect(ran(pg, 'CREATE OR REPLACE TRIGGER')).toBe(true);
    expect(ran(pg, 'SELECT tx_id FROM supapower.changes')).toBe(true);

    sync.unsubscribe();
  });

  test('reports which leadership strategy it ended up with', async () => {
    const plain = await createSupapower(asPGlite(createFakePGlite())).sync({
      supabase,
      tables: [],
    });

    expect(plain.leadership).toBe('single-process');

    const worker = await createSupapower(asPGlite(createFakeWorkerPGlite({ isLeader: true }))).sync(
      { supabase, tables: [] },
    );

    expect(worker.leadership).toBe('worker-leader');

    plain.unsubscribe();
    worker.unsubscribe();
  });

  test('sets up the schema but does not drain when another tab is the leader', async () => {
    const pg = createFakeWorkerPGlite();

    const sync = await createSupapower(asPGlite(pg)).sync({ supabase, tables: ['todos'] });

    await settle();

    expect(ran(pg, 'CREATE SCHEMA IF NOT EXISTS supapower')).toBe(true);
    expect(ran(pg, 'SELECT tx_id FROM supapower.changes')).toBe(false);

    sync.unsubscribe();
  });

  test('starts draining as soon as this tab becomes the leader', async () => {
    const pg = createFakeWorkerPGlite();

    const sync = await createSupapower(asPGlite(pg)).sync({ supabase, tables: ['todos'] });

    await settle();
    pg.setLeader(true);
    await settle();

    expect(ran(pg, 'SELECT tx_id FROM supapower.changes')).toBe(true);

    sync.unsubscribe();
  });

  test('unsubscribe releases leadership and is idempotent', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });

    const sync = await createSupapower(asPGlite(pg)).sync({ supabase, tables: ['todos'] });

    await settle();

    expect(pg.leaderListeners).toBe(1);

    sync.unsubscribe();
    sync.unsubscribe();

    expect(pg.leaderListeners).toBe(0);
  });

  test('aborting the caller signal unsubscribes', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });
    const controller = new AbortController();

    await createSupapower(asPGlite(pg)).sync({
      supabase,
      tables: ['todos'],
      signal: controller.signal,
    });

    await settle();

    expect(pg.leaderListeners).toBe(1);

    controller.abort();

    expect(pg.leaderListeners).toBe(0);
  });

  test('a signal that is already aborted never touches the database', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });

    const sync = await createSupapower(asPGlite(pg)).sync({
      supabase,
      tables: ['todos'],
      signal: AbortSignal.abort(),
    });

    await settle();

    expect(pg.statements).toEqual([]);
    expect(pg.leaderListeners).toBe(0);

    sync.unsubscribe();
  });
});
