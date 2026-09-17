import { describe, expect, test } from 'bun:test';

import { reconcileUser, runInitialSync } from './sync.js';
import { createChange } from './tests/changes.js';
import { asPGlite, createFakePGlite } from './tests/pglite.js';
import { asSupabaseClient, createFakeSupabase } from './tests/supabase.js';
import { resolveTablesWith } from './tests/tables.js';

const tables = resolveTablesWith(['todos', { table: 'plans', access: 'anon' }], {
  todos: ['id', 'title'],
  plans: ['id'],
});

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

    expect(failing).rejects.toThrow('Could not download "public"."todos" from Supabase');
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

    pg.metadata.set('SyncedCursorAt', {
      '"public"."todos"': { at: '2026-01-01T00:00:00.000Z', cursor: 'updated_at', columns: ['id'] },
      '"public"."plans"': { at: 'x', cursor: 'updated_at', columns: ['id'] },
    });

    await reconcileUser(asPGlite(pg), tables, null);

    // "plans" is anon, so it is neither emptied nor forgotten.
    expect(Object.keys(pg.metadata.get('SyncedCursorAt') as object)).toEqual(['"public"."plans"']);
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
  const incremental = resolveTablesWith(
    [
      { table: 'todos', cursor: 'updated_at' },
      { table: 'plans', access: 'anon' },
    ],
    { todos: ['id', 'updated_at'], plans: ['id'] },
  );

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
    expect(pg.metadata.get('SyncedCursorAt')).toEqual({
      '"public"."todos"': {
        at: '2026-01-01T12:00:00.000Z',
        cursor: 'updated_at',
        columns: ['id', 'updated_at'],
      },
    });
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

    expect(pg.metadata.get('SyncedCursorAt')).toMatchObject({
      '"public"."todos"': { at: '2026-01-01T12:00:00.000Z' },
    });
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

describe('runInitialSync - schema drift', () => {
  const drifted = resolveTablesWith([{ table: 'todos', cursor: 'updated_at' }], {
    todos: ['id', 'updated_at'],
  });

  test('asks Supabase only for the columns this client has', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: drifted,
      signal: live(),
    });

    // A column this client has never heard of cannot arrive if it is never
    // asked for.
    expect(supabase.requestedColumns).toEqual(['todos:id,updated_at']);
  });

  test('pulls the whole table again once a column has been added locally', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({
      rows: { todos: [{ id: 1, updated_at: '2026-01-01T12:00:00.000Z' }] },
    });

    const run = (configs: typeof drifted) =>
      runInitialSync({
        pg: asPGlite(pg),
        supabase: asSupabaseClient(supabase),
        tables: configs,
        signal: live(),
      });

    await run(drifted);

    // As after an application migration: the column the server already had is
    // now here, and no row has been downloaded with it.
    await run(
      resolveTablesWith([{ table: 'todos', cursor: 'updated_at' }], {
        todos: ['id', 'title', 'updated_at'],
      }),
    );

    expect(supabase.calls).toEqual(['select:todos', 'select:todos']);
    expect(supabase.requestedColumns).toEqual(['todos:id,updated_at', 'todos:id,title,updated_at']);
  });

  test('keeps using the watermark when a column was only removed', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({
      rows: { todos: [{ id: 1, updated_at: '2026-01-01T12:00:00.000Z' }] },
    });

    const run = (configs: typeof drifted) =>
      runInitialSync({
        pg: asPGlite(pg),
        supabase: asSupabaseClient(supabase),
        tables: configs,
        signal: live(),
      });

    await run(
      resolveTablesWith([{ table: 'todos', cursor: 'updated_at' }], {
        todos: ['id', 'title', 'updated_at'],
      }),
    );
    await run(drifted);

    // Nothing was lost upstream by dropping a column locally, so there is
    // nothing to fetch again.
    expect(supabase.calls).toEqual(['select:todos', 'select:todos:gte(updated_at)']);
  });

  test('pulls the whole table again when the cursor column changes', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({
      rows: { todos: [{ id: 1, updated_at: '2026-01-01T12:00:00.000Z', edited_at: 'x' }] },
    });

    const run = (cursor: string) =>
      runInitialSync({
        pg: asPGlite(pg),
        supabase: asSupabaseClient(supabase),
        tables: resolveTablesWith([{ table: 'todos', cursor }], {
          todos: ['edited_at', 'id', 'updated_at'],
        }),
        signal: live(),
      });

    await run('updated_at');
    await run('edited_at');

    // The stored value came out of a different column; comparing the new one
    // against it would quietly fetch the wrong set.
    expect(supabase.calls).toEqual(['select:todos', 'select:todos']);
  });
});

describe('runInitialSync - tables outside "public"', () => {
  const configured = resolveTablesWith(
    [
      { table: 'todos', schema: 'app' },
      { table: 'notes', schema: 'app', localSchema: 'mirror' },
    ],
    { 'app.todos': ['id', 'title'], 'mirror.notes': ['id', 'title'] },
  );

  test('downloads from the schema each table was configured for', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: configured,
      signal: live(),
    });

    expect(supabase.calls).toEqual(['select:todos', 'select:notes']);
    expect(supabase.schemas).toEqual(['app', 'app']);
  });

  test('writes the rows into the local schema', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({
      rows: { todos: [{ id: 1, title: 'one' }], notes: [{ id: 2, title: 'two' }] },
    });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: configured,
      signal: live(),
    });

    const inserts = pg.statements.filter((statement) => statement.startsWith('INSERT INTO'));

    expect(inserts[0]).toContain('INSERT INTO "app"."todos"');
    // Downloaded from "app" upstream, but it lives in "mirror" here.
    expect(inserts[1]).toContain('INSERT INTO "mirror"."notes"');
  });

  test('keys the watermark by where the table lives locally', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({
      rows: { notes: [{ id: 1, updated_at: '2026-01-01T12:00:00.000Z' }] },
    });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: resolveTablesWith(
        [{ table: 'notes', schema: 'app', localSchema: 'mirror', cursor: 'updated_at' }],
        { 'mirror.notes': ['id', 'updated_at'] },
      ),
      signal: live(),
    });

    expect(Object.keys(pg.metadata.get('SyncedCursorAt') as object)).toEqual(['"mirror"."notes"']);
  });
});

describe('reconcileUser - tables outside "public"', () => {
  const configured = resolveTablesWith([{ table: 'notes', schema: 'app', localSchema: 'mirror' }], {
    'mirror.notes': ['id'],
  });

  test('truncates the local schema and drops only its queued changes', async () => {
    const pg = createFakePGlite({
      changes: [
        createChange('100', 1, { schema_name: 'mirror', table_name: 'notes' }),
        createChange('101', 2, { schema_name: 'public', table_name: 'notes' }),
      ],
    });

    await reconcileUser(asPGlite(pg), configured, 'user-a');

    expect(pg.statements).toContain('TRUNCATE TABLE "mirror"."notes"');
    // The same-named table in "public" is not configured, so it is untouched.
    expect(pg.queue.map((change) => change.schema_name)).toEqual(['public']);
  });
});
