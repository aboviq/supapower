import { describe, expect, test } from 'bun:test';

import { createSupapowerEvents } from './events.js';
import { reconcileFilters, reconcileUser, runInitialSync } from './sync.js';
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

const rowsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));

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

  test('dispatches download events around each table, in order', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();
    const events = createSupapowerEvents();
    const seen: string[] = [];

    events.addEventListener('downloadStart', () => seen.push('downloadStart'));
    events.addEventListener('downloadTableStart', (event) =>
      seen.push(`start:${event.config.table}`),
    );
    events.addEventListener('downloadTableFinish', (event) =>
      seen.push(`finish:${event.config.table}`),
    );
    events.addEventListener('downloadFinish', () => seen.push('downloadFinish'));

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: live(),
      events,
    });

    expect(seen).toEqual([
      'downloadStart',
      'start:todos',
      'finish:todos',
      'start:plans',
      'finish:plans',
      'downloadFinish',
    ]);
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

  test('narrows the download and records the filter it ran with', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();
    const filtered = resolveTablesWith(
      [{ table: 'todos', filter: (f) => f.eq('workspace_id', 7) }],
      { todos: ['id', 'title', 'workspace_id'] },
    );

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: filtered,
      signal: live(),
    });

    expect(supabase.calls).toEqual(['select:todos:filter(workspace_id=eq.7)']);

    const state = pg.metadata.get('TableSyncState') as Record<string, { filter?: string }>;

    expect(state['"public"."todos"']?.filter).toBe('workspace_id=eq.7');
  });
});

describe('runInitialSync - throttling repeated downloads', () => {
  test('skips a table whose last download is still fresh', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();

    pg.metadata.set('TableSyncState', {
      '"public"."todos"': { downloadedAt: Date.now(), columns: ['id', 'title'] },
    });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: live(),
    });

    expect(supabase.calls).toEqual(['select:plans']);
  });

  test('downloads a table again once its record has aged past the throttle', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();

    pg.metadata.set('TableSyncState', {
      '"public"."todos"': { downloadedAt: Date.now() - 120_000, columns: ['id', 'title'] },
    });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: live(),
    });

    expect(supabase.calls).toEqual(['select:todos', 'select:plans']);
  });

  test('downloads a table anyway when a column was added locally since', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();

    pg.metadata.set('TableSyncState', {
      '"public"."todos"': { downloadedAt: Date.now(), columns: ['id'] },
    });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: live(),
    });

    expect(supabase.calls).toEqual(['select:todos', 'select:plans']);
  });

  test('a second pass over the same database repeats no download', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();

    const run = () =>
      runInitialSync({
        pg: asPGlite(pg),
        supabase: asSupabaseClient(supabase),
        tables,
        signal: live(),
      });

    await run();
    await run();

    expect(supabase.calls).toEqual(['select:todos', 'select:plans']);
  });

  test('downloadThrottle: 0 downloads every table regardless of freshness', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();

    pg.metadata.set('TableSyncState', {
      '"public"."todos"': { downloadedAt: Date.now(), columns: ['id', 'title'] },
    });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: live(),
      downloadThrottle: 0,
    });

    expect(supabase.calls).toEqual(['select:todos', 'select:plans']);
  });

  test('dispatches downloadStart/downloadFinish but no per-table events when every table is fresh', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();
    const events = createSupapowerEvents();
    const seen: string[] = [];

    pg.metadata.set('TableSyncState', {
      '"public"."todos"': { downloadedAt: Date.now(), columns: ['id', 'title'] },
      '"public"."plans"': { downloadedAt: Date.now(), columns: ['id'] },
    });

    events.addEventListener('downloadStart', () => seen.push('downloadStart'));
    events.addEventListener('downloadTableStart', (event) =>
      seen.push(`start:${event.config.table}`),
    );
    events.addEventListener('downloadTableFinish', (event) =>
      seen.push(`finish:${event.config.table}`),
    );
    events.addEventListener('downloadFinish', () => seen.push('downloadFinish'));

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: live(),
      events,
    });

    expect(seen).toEqual(['downloadStart', 'downloadFinish']);
    expect(supabase.calls).toEqual([]);
  });

  test('a failed download does not become fresh', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase({
      downloadError: (table) => (table === 'todos' ? { code: '42501', message: 'denied' } : null),
    });

    await expect(
      runInitialSync({
        pg: asPGlite(pg),
        supabase: asSupabaseClient(supabase),
        tables,
        signal: live(),
      }),
    ).rejects.toThrow('Could not download "public"."todos" from Supabase');

    expect(
      (pg.metadata.get('TableSyncState') as Record<string, unknown> | undefined)?.[
        '"public"."todos"'
      ],
    ).toBeUndefined();
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

    pg.metadata.set('TableSyncState', {
      '"public"."todos"': {
        at: '2026-01-01T00:00:00.000Z',
        cursor: 'updated_at',
        columns: ['id'],
        downloadedAt: 0,
      },
      '"public"."plans"': { at: 'x', cursor: 'updated_at', columns: ['id'], downloadedAt: 0 },
    });

    await reconcileUser(asPGlite(pg), tables, null);

    // "plans" is anon, so it is neither emptied nor forgotten.
    expect(Object.keys(pg.metadata.get('TableSyncState') as object)).toEqual(['"public"."plans"']);
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

describe('reconcileFilters', () => {
  const filteredTable = resolveTablesWith(
    [{ table: 'todos', filter: (f) => f.eq('workspace_id', 8) }],
    { todos: ['id', 'workspace_id'] },
  );

  test('truncates a table whose resolved filter changed since its last download', async () => {
    const pg = createFakePGlite();

    pg.metadata.set('TableSyncState', {
      '"public"."todos"': {
        downloadedAt: 0,
        columns: ['id', 'workspace_id'],
        filter: 'workspace_id=eq.7',
      },
    });

    const changed = await reconcileFilters(asPGlite(pg), filteredTable);

    expect(changed).toEqual(['"public"."todos"']);
    expect(pg.truncated).toEqual(['todos']);
    expect(pg.metadata.get('TableSyncState')).toEqual({});
  });

  test('leaves queued outgoing changes alone, unlike reconcileUser', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1, { table_name: 'todos' })] });

    pg.metadata.set('TableSyncState', {
      '"public"."todos"': {
        downloadedAt: 0,
        columns: ['id', 'workspace_id'],
        filter: 'workspace_id=eq.7',
      },
    });

    await reconcileFilters(asPGlite(pg), filteredTable);

    expect(pg.queue.map((change) => change.table_name)).toEqual(['todos']);
  });

  test('does nothing when the resolved filter matches what was stored', async () => {
    const pg = createFakePGlite();

    pg.metadata.set('TableSyncState', {
      '"public"."todos"': {
        downloadedAt: 0,
        columns: ['id', 'workspace_id'],
        filter: 'workspace_id=eq.8',
      },
    });

    const changed = await reconcileFilters(asPGlite(pg), filteredTable);

    expect(changed).toEqual([]);
    expect(pg.truncated).toEqual([]);
  });

  test('does nothing for a table that was never downloaded', async () => {
    const pg = createFakePGlite();

    const changed = await reconcileFilters(asPGlite(pg), filteredTable);

    expect(changed).toEqual([]);
    expect(pg.truncated).toEqual([]);
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

    expect(supabase.calls).toEqual(['select:todos', 'select:todos', 'select:plans']);
    expect(pg.metadata.get('TableSyncState')).toEqual({
      '"public"."todos"': {
        at: '2026-01-01T12:00:00.000Z',
        cursor: 'updated_at',
        columns: ['id', 'updated_at'],
        downloadedAt: expect.any(Number),
      },
      '"public"."plans"': { columns: ['id'], downloadedAt: expect.any(Number) },
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
        downloadThrottle: 0,
      });

    await run();
    await run();

    expect(supabase.calls).toEqual([
      'select:todos',
      'select:todos',
      'select:plans',
      'select:todos:gte(updated_at)',
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
      downloadThrottle: 0,
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
      downloadThrottle: 0,
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
      downloadThrottle: 0,
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
      downloadThrottle: 0,
    });

    expect(pg.metadata.get('TableSyncState')).toMatchObject({
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
      downloadThrottle: 0,
    });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: incremental,
      signal: live(),
      downloadThrottle: 0,
    });

    expect(supabase.calls.filter((call) => call.startsWith('select:todos'))).toEqual([
      'select:todos',
      'select:todos',
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

    expect(Object.keys(pg.metadata.get('TableSyncState') as object)).toEqual(['"public"."plans"']);
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

    expect(supabase.calls).toEqual([
      'select:todos',
      'select:todos',
      'select:todos',
      'select:todos',
    ]);
    expect(supabase.requestedColumns).toEqual([
      'todos:id,updated_at',
      'todos:id,updated_at',
      'todos:id,title,updated_at',
      'todos:id,title,updated_at',
    ]);
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
        downloadThrottle: 0,
      });

    await run(
      resolveTablesWith([{ table: 'todos', cursor: 'updated_at' }], {
        todos: ['id', 'title', 'updated_at'],
      }),
    );
    await run(drifted);

    // Nothing was lost upstream by dropping a column locally, so there is
    // nothing to fetch again.
    expect(supabase.calls).toEqual([
      'select:todos',
      'select:todos',
      'select:todos:gte(updated_at)',
      'select:todos:gte(updated_at)',
    ]);
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
    expect(supabase.calls).toEqual([
      'select:todos',
      'select:todos',
      'select:todos',
      'select:todos',
    ]);
  });
});

describe('runInitialSync - pagination', () => {
  test('pages through every row of a table bigger than one page', async () => {
    const pg = createFakePGlite();
    const rows = rowsOf(2500);
    const supabase = createFakeSupabase({ rows: { todos: rows } });
    const paged = resolveTablesWith([{ table: 'todos', cursor: 'updated_at' }], {
      todos: ['id', 'updated_at'],
    });

    await runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: paged,
      signal: live(),
    });

    expect(applied(pg)).toHaveLength(2500);
    expect(pg.metadata.get('TableSyncState')).toEqual({
      '"public"."todos"': {
        at: rows.at(-1)?.updated_at,
        cursor: 'updated_at',
        columns: ['id', 'updated_at'],
        downloadedAt: expect.any(Number),
      },
    });
    // Three full pages plus the empty page that ends the loop.
    expect(supabase.calls.filter((call) => call.startsWith('select:todos'))).toHaveLength(4);
  });

  test('never writes a watermark for a table that failed partway through paging', async () => {
    const pg = createFakePGlite();
    let attempt = 0;
    const supabase = createFakeSupabase({
      rows: { todos: rowsOf(1500) },
      downloadError: (table) => {
        if (table !== 'todos') {
          return null;
        }

        attempt += 1;

        // Fails the second page, once the first has already been applied.
        return attempt === 2 ? { code: '50000', message: 'boom' } : null;
      },
    });
    const paged = resolveTablesWith([{ table: 'todos', cursor: 'updated_at' }], {
      todos: ['id', 'updated_at'],
    });

    const failing = runInitialSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: paged,
      signal: live(),
    });

    await expect(failing).rejects.toThrow('Could not download "public"."todos" from Supabase');

    const watermark = pg.metadata.get('TableSyncState') as Record<string, unknown> | undefined;

    expect(watermark?.['"public"."todos"']).toBeUndefined();
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

    const inserts = pg.statements.filter((statement) => statement.startsWith('INSERT INTO "'));

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

    expect(Object.keys(pg.metadata.get('TableSyncState') as object)).toEqual(['"mirror"."notes"']);
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
