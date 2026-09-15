import { describe, expect, test } from 'bun:test';

import { createSupapower } from './index.js';
import { settle, waitFor } from './tests/async.js';
import {
  asPGlite,
  createFakePGlite,
  createFakeWorkerPGlite,
  type FakePGlite,
} from './tests/pglite.js';
import { asSupabaseClient, createFakeSupabase, type FakeSupabase } from './tests/supabase.js';

/** Nothing is ever pushed or subscribed in the lifecycle tests below. */
const idleSupabase = asSupabaseClient(createFakeSupabase());

const ran = (pg: FakePGlite, fragment: string) =>
  pg.statements.some((statement) => statement.includes(fragment));

describe('createSupapower().sync', () => {
  test('sets up the schema and starts draining the queue', async () => {
    const pg = createFakePGlite();

    const sync = await createSupapower(asPGlite(pg)).sync({
      supabase: idleSupabase,
      tables: ['todos'],
    });

    await settle();

    expect(ran(pg, 'CREATE SCHEMA IF NOT EXISTS supapower')).toBe(true);
    expect(ran(pg, 'CREATE OR REPLACE TRIGGER')).toBe(true);
    expect(ran(pg, 'SELECT tx_id FROM supapower.changes')).toBe(true);

    sync.unsubscribe();
  });

  test('reports which leadership strategy it ended up with', async () => {
    const plain = await createSupapower(asPGlite(createFakePGlite())).sync({
      supabase: idleSupabase,
      tables: [],
    });

    expect(plain.leadership).toBe('single-process');

    const worker = await createSupapower(asPGlite(createFakeWorkerPGlite({ isLeader: true }))).sync(
      { supabase: idleSupabase, tables: [] },
    );

    expect(worker.leadership).toBe('worker-leader');

    plain.unsubscribe();
    worker.unsubscribe();
  });

  test('sets up the schema but does not drain when another tab is the leader', async () => {
    const pg = createFakeWorkerPGlite();

    const sync = await createSupapower(asPGlite(pg)).sync({
      supabase: idleSupabase,
      tables: ['todos'],
    });

    await settle();

    expect(ran(pg, 'CREATE SCHEMA IF NOT EXISTS supapower')).toBe(true);
    expect(ran(pg, 'SELECT tx_id FROM supapower.changes')).toBe(false);

    sync.unsubscribe();
  });

  test('starts draining as soon as this tab becomes the leader', async () => {
    const pg = createFakeWorkerPGlite();

    const sync = await createSupapower(asPGlite(pg)).sync({
      supabase: idleSupabase,
      tables: ['todos'],
    });

    await settle();
    pg.setLeader(true);
    await settle();

    expect(ran(pg, 'SELECT tx_id FROM supapower.changes')).toBe(true);

    sync.unsubscribe();
  });

  test('unsubscribe releases leadership and is idempotent', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });

    const sync = await createSupapower(asPGlite(pg)).sync({
      supabase: idleSupabase,
      tables: ['todos'],
    });

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
      supabase: idleSupabase,
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
      supabase: idleSupabase,
      tables: ['todos'],
      signal: AbortSignal.abort(),
    });

    await settle();

    expect(pg.statements).toEqual([]);
    expect(pg.leaderListeners).toBe(0);

    sync.unsubscribe();
  });
});

describe('createSupapower().sync - incoming subscription', () => {
  const tables = ['todos', { table: 'plans', access: 'anon' as const }];

  const start = async (supabase: FakeSupabase, pg = createFakeWorkerPGlite({ isLeader: true })) => {
    const sync = await createSupapower(asPGlite(pg)).sync({
      supabase: asSupabaseClient(supabase),
      tables,
    });

    await settle(); // the auth listener reports INITIAL_SESSION on a microtask

    return sync;
  };

  test('subscribes to the anon tables only while nobody is signed in', async () => {
    const supabase = createFakeSupabase();

    const sync = await start(supabase);

    expect(supabase.openChannel?.bindings).toEqual(['public.plans']);

    sync.unsubscribe();
  });

  test('picks up the authenticated tables once a user is signed in', async () => {
    const supabase = createFakeSupabase({ user: 'user-a' });

    const sync = await start(supabase);

    expect(supabase.openChannel?.bindings).toEqual(['public.todos', 'public.plans']);

    sync.unsubscribe();
  });

  test('leaves the channel alone when only the token was refreshed', async () => {
    const supabase = createFakeSupabase({ user: 'user-a' });

    const sync = await start(supabase);
    const channel = supabase.openChannel;

    supabase.refreshToken();
    await settle();

    // supabase-js pushes the new token onto the socket itself, so re-subscribing
    // would drop messages for nothing.
    expect(supabase.openChannel).toBe(channel);
    expect(supabase.channels).toHaveLength(1);

    sync.unsubscribe();
  });

  test('re-subscribes when a different user signs in', async () => {
    const supabase = createFakeSupabase({ user: 'user-a' });

    const sync = await start(supabase);
    const first = supabase.openChannel;

    supabase.setUser('user-b');
    await settle();

    expect(first?.removed).toBe(true);
    expect(supabase.channels).toHaveLength(2);
    expect(supabase.openChannel?.bindings).toEqual(['public.todos', 'public.plans']);

    sync.unsubscribe();
  });

  test('drops back to the anon tables on sign out', async () => {
    const supabase = createFakeSupabase({ user: 'user-a' });

    const sync = await start(supabase);

    supabase.setUser(null);
    await settle();

    expect(supabase.openChannel?.bindings).toEqual(['public.plans']);

    sync.unsubscribe();
  });

  test('treats a client that owns its own token as always signed in', async () => {
    // `supabase.auth` throws on every access for a client built with the
    // `accessToken` option, so there is no auth state to follow.
    const supabase = createFakeSupabase({ auth: false });

    const sync = await start(supabase);

    expect(supabase.openChannel?.bindings).toEqual(['public.todos', 'public.plans']);

    sync.unsubscribe();
  });

  test('closes the channel on unsubscribe', async () => {
    const supabase = createFakeSupabase({ user: 'user-a' });

    const sync = await start(supabase);
    const channel = supabase.openChannel;

    sync.unsubscribe();

    // `unsubscribe()` returns as soon as it has signalled; leaving the channel
    // is a round trip to the server and settles a moment later.
    expect(await waitFor(() => channel?.removed === true)).toBe(true);
  });

  test('does not subscribe at all when another tab is the leader', async () => {
    const supabase = createFakeSupabase({ user: 'user-a' });

    const sync = await start(supabase, createFakeWorkerPGlite());

    expect(supabase.channels).toEqual([]);

    sync.unsubscribe();
  });
});
