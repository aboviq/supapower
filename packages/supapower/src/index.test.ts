import { describe, expect, test } from 'bun:test';

import { isSupapowerError } from './errors.js';
import { createSupapower } from './index.js';
import { settle, waitFor } from './tests/async.js';
import { createChange } from './tests/changes.js';
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

describe('createSupapower().sync - initial download', () => {
  const tables = ['todos', { table: 'plans', access: 'anon' as const }];

  const start = async (supabase: FakeSupabase, pg: FakePGlite) => {
    const sync = await createSupapower(asPGlite(pg)).sync({
      supabase: asSupabaseClient(supabase),
      tables,
    });

    await settle();

    return sync;
  };

  test('downloads only the anon tables while nobody is signed in', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });
    const supabase = createFakeSupabase();

    const sync = await start(supabase, pg);

    expect(await waitFor(() => supabase.calls.includes('select:plans'))).toBe(true);
    expect(supabase.calls).not.toContain('select:todos');

    sync.unsubscribe();
  });

  test('downloads every table once a user is signed in', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });
    const supabase = createFakeSupabase({ user: 'user-a', rows: { todos: [{ id: 1 }] } });

    const sync = await start(supabase, pg);

    expect(await waitFor(() => supabase.calls.includes('select:plans'))).toBe(true);
    expect(supabase.calls).toEqual(['select:todos', 'select:plans']);
    expect(pg.statements.some((s) => s.includes('INSERT INTO "public"."todos"'))).toBe(true);

    sync.unsubscribe();
  });

  test('empties and re-downloads the authenticated tables when the user changes', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });
    const supabase = createFakeSupabase({ user: 'user-a' });

    const sync = await start(supabase, pg);

    await waitFor(() => supabase.calls.includes('select:plans'));

    supabase.setUser('user-b');

    expect(await waitFor(() => pg.truncated.length > 0)).toBe(true);
    expect(pg.truncated).toEqual(['todos']);
    expect(
      await waitFor(() => supabase.calls.filter((c) => c === 'select:todos').length === 2),
    ).toBe(true);

    sync.unsubscribe();
  });

  test('empties the authenticated tables on sign out and does not re-download them', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });
    const supabase = createFakeSupabase({ user: 'user-a' });

    const sync = await start(supabase, pg);

    await waitFor(() => supabase.calls.includes('select:plans'));
    supabase.setUser(null);

    expect(await waitFor(() => pg.truncated.includes('todos'))).toBe(true);
    await settle();

    expect(supabase.calls.filter((call) => call === 'select:todos')).toHaveLength(1);

    sync.unsubscribe();
  });

  test('leaves everything alone when only the token was refreshed', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true });
    const supabase = createFakeSupabase({ user: 'user-a' });

    const sync = await start(supabase, pg);

    await waitFor(() => supabase.calls.includes('select:plans'));

    // The first sync for a user always truncates once, to clear out whoever
    // was there before; the refresh must not add to that.
    const before = [...supabase.calls];
    const truncatedBefore = [...pg.truncated];

    supabase.refreshToken();
    await settle();

    expect(pg.truncated).toEqual(truncatedBefore);
    expect(supabase.calls).toEqual(before);

    sync.unsubscribe();
  });
});

describe('createSupapower().sync - waiting for authentication', () => {
  const tables = ['todos', { table: 'plans', access: 'anon' as const }];

  const start = async (supabase: FakeSupabase, pg: FakePGlite) =>
    createSupapower(asPGlite(pg)).sync({
      supabase: asSupabaseClient(supabase),
      tables,
    });

  test('touches nothing until the auth client has reported an identity', async () => {
    const pg = createFakeWorkerPGlite({
      isLeader: true,
      changes: [createChange('100', 1, { table_name: 'todos' })],
    });
    const supabase = createFakeSupabase({ user: 'user-a' });

    // As after a reload: the local data already belongs to this user, so
    // nothing is truncated and the queued change survives.
    pg.metadata.set('SyncedUser', 'user-a');

    await start(supabase, pg);

    // The first onAuthStateChange notification lands a microtask later, the way
    // supabase-js flushes it once its own initialization has settled.
    expect(supabase.calls).toEqual([]);

    expect(await waitFor(() => supabase.calls.includes('upsert:todos'))).toBe(true);
  });

  test('holds back queued changes for tables the signed out user cannot reach', async () => {
    const pg = createFakeWorkerPGlite({
      isLeader: true,
      changes: [
        createChange('100', 1, { table_name: 'todos' }),
        createChange('101', 2, { table_name: 'plans' }),
      ],
    });
    const supabase = createFakeSupabase();

    const sync = await start(supabase, pg);

    expect(await waitFor(() => supabase.calls.includes('upsert:plans'))).toBe(true);
    await settle();

    // Pushing "todos" now would go out with the anon key, come back as a
    // row-level security denial, and be discarded as unrecoverable.
    expect(supabase.calls).not.toContain('upsert:todos');
    expect(pg.queue.map((change) => change.table_name)).toEqual(['todos']);

    sync.unsubscribe();
  });
});

describe('createSupapower().sync - primary key validation', () => {
  test('refuses to start when a configured primary key is not a column', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true, columns: { tags: ['id', 'name'] } });

    const failing = createSupapower(asPGlite(pg)).sync({
      supabase: idleSupabase,
      tables: [{ table: 'tags', primaryKey: 'tag_id' }],
    });

    const thrown = await failing.catch((error: unknown) => error);

    expect(isSupapowerError(thrown) && thrown.code).toBe('schema_mismatch');
  });
});

describe('createSupapower().sync - tables outside "public"', () => {
  test('tracks, subscribes and pushes each table where it belongs', async () => {
    const pg = createFakeWorkerPGlite({
      isLeader: true,
      columns: { 'app.todos': ['id', 'title'], 'mirror.notes': ['id', 'title'] },
      changes: [createChange('100', 1, { schema_name: 'mirror', table_name: 'notes' })],
    });
    const supabase = createFakeSupabase({ user: 'user-a' });

    // As after a reload: the queued change belongs to this user, so nothing is
    // truncated out from under it.
    pg.metadata.set('SyncedUser', 'user-a');

    const sync = await createSupapower(asPGlite(pg)).sync({
      supabase: asSupabaseClient(supabase),
      tables: [
        { table: 'todos', schema: 'app' },
        { table: 'notes', schema: 'app', localSchema: 'mirror' },
      ],
    });

    await settle();

    expect(ran(pg, 'AFTER INSERT ON "app"."todos"')).toBe(true);
    expect(ran(pg, 'AFTER INSERT ON "mirror"."notes"')).toBe(true);
    expect(supabase.openChannel?.bindings).toEqual(['app.todos', 'app.notes']);

    expect(await waitFor(() => supabase.calls.includes('upsert:notes'))).toBe(true);
    expect(supabase.schemas.every((schema) => schema === 'app')).toBe(true);

    sync.unsubscribe();
  });

  test('refuses a primary key the table lacks in its local schema', async () => {
    const pg = createFakeWorkerPGlite({ isLeader: true, columns: { 'app.tags': ['id', 'name'] } });

    const failing = createSupapower(asPGlite(pg)).sync({
      supabase: idleSupabase,
      tables: [{ table: 'tags', schema: 'app', primaryKey: 'tag_id' }],
    });

    const thrown = await failing.catch((error: unknown) => error);

    expect(isSupapowerError(thrown) && thrown.code).toBe('schema_mismatch');
    expect(String(thrown)).toContain('Table "app"."tags"');
  });
});
