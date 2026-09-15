import { describe, expect, test } from 'bun:test';

import { reconcileUser, resolveTables, runInitialSync } from './sync.js';
import { createChange } from './tests/changes.js';
import { asPGlite, createFakePGlite } from './tests/pglite.js';
import { asSupabaseClient, createFakeSupabase } from './tests/supabase.js';

const tables = resolveTables(['todos', { table: 'plans', access: 'anon' }]);

const live = () => new AbortController().signal;

const applied = (pg: { statements: string[] }) =>
  pg.statements.filter((statement) => statement.startsWith('INSERT INTO "public"'));

describe('runInitialSync', () => {
  test('downloads every table in the configured order', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: live(),
    });

    expect(supabase.calls).toEqual(['select:todos', 'select:plans']);
  });

  test('writes the downloaded rows in as upserts, with the trigger suppressed', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({
      rows: {
        todos: [
          { id: 1, title: 'one' },
          { id: 2, title: 'two' },
        ],
      },
    });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: live(),
    });

    expect(applied(pg)).toHaveLength(2);
    expect(applied(pg)[0]).toContain('ON CONFLICT ("id") DO UPDATE SET');
    // Without this the snapshot would be queued straight back up as outgoing.
    expect(pg.statements).toContain("SELECT set_config('supapower.applying', 'true', true)");
  });

  test('leaves a watermark for each downloaded table', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({ rows: { todos: [{ id: 1 }], plans: [{ id: 9 }] } });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: live(),
    });

    expect(Object.keys(pg.metadata.get('SyncedIncomingAt') as object)).toEqual(['todos', 'plans']);
  });

  test('reports a failed download rather than carrying on', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({
      downloadError: (table) => (table === 'todos' ? { code: '42501', message: 'denied' } : null),
    });

    const failing = runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: live(),
    });

    expect(failing).rejects.toThrow('Could not download "todos" from Supabase');
  });

  test('stops downloading once the signal aborts', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({ rows: { todos: [{ id: 1 }] } });
    const controller = new AbortController();

    controller.abort();

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
    });

    expect(supabase.calls).toEqual([]);
  });
});

describe('reconcileUser', () => {
  test('truncates the authenticated tables when the user changes', async () => {
    const pg = createFakePGlite();

    const dropped = await reconcileUser(asPGlite(pg), tables, 'user-a');

    expect(dropped).toBe(true);
    // "plans" is anon: readable by everyone, so it survives.
    expect(pg.truncated).toEqual(['todos']);
    expect(pg.metadata.get('SyncedUser')).toBe('user-a');
  });

  test('does nothing when the same user is still signed in', async () => {
    const pg = createFakePGlite();

    await reconcileUser(asPGlite(pg), tables, 'user-a');

    const dropped = await reconcileUser(asPGlite(pg), tables, 'user-a');

    expect(dropped).toBe(false);
    expect(pg.truncated).toEqual(['todos']); // still just the first call's
  });

  test('drops queued outgoing changes belonging to the previous user', async () => {
    const pg = createFakePGlite({
      changes: [
        createChange('100', 1, { table_name: 'todos' }),
        createChange('101', 2, { table_name: 'plans' }),
      ],
    });

    await reconcileUser(asPGlite(pg), tables, 'user-a');

    // The previous user's unsent writes cannot be pushed as the next user.
    expect(pg.queue.map((change) => change.table_name)).toEqual(['plans']);
  });

  test('forgets the watermarks of the tables it emptied', async () => {
    const pg = createFakePGlite();

    await reconcileUser(asPGlite(pg), tables, 'user-a');

    pg.metadata.set('SyncedIncomingAt', { todos: '2026-01-01T00:00:00.000Z', plans: 'x' });

    await reconcileUser(asPGlite(pg), tables, null);

    expect(pg.metadata.get('SyncedIncomingAt')).toEqual({ plans: 'x' });
  });

  test('treats a database that was never synced as nothing to clear', async () => {
    const pg = createFakePGlite();

    const dropped = await reconcileUser(asPGlite(pg), tables, null);

    expect(dropped).toBe(false);
    expect(pg.truncated).toEqual([]);
  });

  test('clears the previous user on sign out', async () => {
    const pg = createFakePGlite();

    await reconcileUser(asPGlite(pg), tables, 'user-a');
    await reconcileUser(asPGlite(pg), tables, null);

    expect(pg.truncated).toEqual(['todos', 'todos']);
    expect(pg.metadata.get('SyncedUser')).toBeNull();
  });
});

describe('runInitialSync - incremental with a cursor', () => {
  const incremental = resolveTables([
    { table: 'todos', cursor: 'updated_at' },
    { table: 'plans', access: 'anon' },
  ]);

  const rows = {
    todos: [
      { id: 1, updated_at: '2026-01-01T10:00:00.000Z' },
      { id: 2, updated_at: '2026-01-01T12:00:00.000Z' },
    ],
  };

  test('pulls the whole table the first time', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({ rows });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: incremental,
      signal: live(),
    });

    expect(supabase.calls).toEqual(['select:todos', 'select:plans']);
    expect(pg.metadata.get('SyncedCursorAt')).toEqual({ todos: '2026-01-01T12:00:00.000Z' });
  });

  test('asks only for what is new the next time', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({ rows });

    const run = () =>
      runInitialSync({
        pg: asPGlite(pg),
        supabase: asSupabaseClient(supabase),
        tables: incremental,
        signal: live(),
      });

    await run();
    await run();

    expect(supabase.calls).toEqual([
      'select:todos',
      'select:plans',
      'select:todos:gte(updated_at)',
      // No cursor configured, so this one is still pulled whole.
      'select:plans',
    ]);
  });

  test('reaches back beyond the last value it saw', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({ rows });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: incremental,
      signal: live(),
    });

    const insertsOfTodos = () =>
      pg.statements.filter((statement) => statement.includes('INSERT INTO "public"."todos"'))
        .length;

    const before = insertsOfTodos();

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: incremental,
      signal: live(),
    });

    // The 12:00 row comes back: the margin covers a transaction that stamped
    // itself before the watermark but committed after it.
    expect(insertsOfTodos() - before).toBe(1);
  });

  test('never moves the watermark backwards', async () => {
    const pg = createFakePGlite();

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(createFakeSupabase({ rows })),
      tables: incremental,
      signal: live(),
    });

    // As if the newest row had been hard deleted upstream.
    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(
        createFakeSupabase({
          rows: { todos: [{ id: 1, updated_at: '2026-01-01T10:00:00.000Z' }] },
        }),
      ),
      tables: incremental,
      signal: live(),
    });

    expect(pg.metadata.get('SyncedCursorAt')).toEqual({ todos: '2026-01-01T12:00:00.000Z' });
  });

  test('falls back to a whole table when the cursor is not a timestamp', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({ rows: { todos: [{ id: 1, updated_at: 'v7' }] } });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: incremental,
      signal: live(),
    });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: incremental,
      signal: live(),
    });

    expect(supabase.calls.filter((call) => call.startsWith('select:todos'))).toEqual([
      'select:todos',
      'select:todos',
    ]);
  });

  test('forgets the cursor for tables it empties on a user change', async () => {
    const pg = createFakePGlite();

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(createFakeSupabase({ rows })),
      tables: incremental,
      signal: live(),
    });

    await reconcileUser(asPGlite(pg), incremental, 'user-a');

    expect(pg.metadata.get('SyncedCursorAt')).toEqual({});
  });
});
