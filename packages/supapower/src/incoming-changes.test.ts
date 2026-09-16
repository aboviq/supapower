import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PGlite } from '@electric-sql/pglite';
import type {
  RealtimePostgresChangesPayload,
  RealtimePostgresDeletePayload,
  RealtimePostgresInsertPayload,
  RealtimePostgresUpdatePayload,
} from '@supabase/supabase-js';

import { runMigrations, trackTables } from './migrations.js';
import { handleIncomingChange } from './sync.js';

type Row = Record<string, unknown>;

let pg: PGlite;

beforeEach(async () => {
  pg = new PGlite();

  await pg.exec(`
    CREATE TABLE todos (id uuid PRIMARY KEY, title text, done boolean);
    CREATE TABLE tags (tag_id uuid PRIMARY KEY, name text);
    CREATE TABLE "odd names" ("group" text PRIMARY KEY, "select" text);
  `);

  await runMigrations(pg);
});

afterEach(async () => {
  await pg.close();
});

const AT = '2026-01-01T12:00:00.000Z';

const insert = (table: string, row: Row): RealtimePostgresInsertPayload<Row> => ({
  eventType: 'INSERT',
  schema: 'public',
  table,
  commit_timestamp: AT,
  new: row,
  old: {},
  errors: [],
});

const update = (table: string, row: Row, old: Row): RealtimePostgresUpdatePayload<Row> => ({
  eventType: 'UPDATE',
  schema: 'public',
  table,
  commit_timestamp: AT,
  new: row,
  old,
  errors: [],
});

const remove = (table: string, old: Row): RealtimePostgresDeletePayload<Row> => ({
  eventType: 'DELETE',
  schema: 'public',
  table,
  commit_timestamp: AT,
  new: {},
  old,
  errors: [],
});

/** The local schema each table is given in `beforeEach`. */
const LOCAL: Record<string, string[]> = {
  todos: ['done', 'id', 'title'],
  tags: ['name', 'tag_id'],
  'odd names': ['group', 'select'],
};

const apply = (payload: RealtimePostgresChangesPayload<Row>, primaryKey = 'id') =>
  handleIncomingChange(pg, payload, { primaryKey, columns: LOCAL[payload.table] ?? [] });

const rowsOf = async <T>(query: string) => (await pg.query<T>(query)).rows;

const ONE = '11111111-1111-1111-1111-111111111111';
const TWO = '22222222-2222-2222-2222-222222222222';

describe('handleIncomingChange', () => {
  test('inserts a remote row', async () => {
    await apply(insert('todos', { id: ONE, title: 'from another device', done: false }));

    expect(await rowsOf('SELECT id, title, done FROM todos')).toEqual([
      { id: ONE, title: 'from another device', done: false },
    ]);
  });

  test('upserts, so re-applying the same insert is harmless', async () => {
    await apply(insert('todos', { id: ONE, title: 'first', done: false }));
    await apply(insert('todos', { id: ONE, title: 'second', done: true }));

    expect(await rowsOf('SELECT title, done FROM todos')).toEqual([
      { title: 'second', done: true },
    ]);
  });

  test('upserts on the configured primary key, not on "id"', async () => {
    await apply(insert('tags', { tag_id: ONE, name: 'first' }), 'tag_id');
    await apply(insert('tags', { tag_id: ONE, name: 'second' }), 'tag_id');

    expect(await rowsOf('SELECT tag_id, name FROM tags')).toEqual([
      { tag_id: ONE, name: 'second' },
    ]);
  });

  test('updates a row', async () => {
    await pg.exec(`INSERT INTO todos VALUES ('${ONE}', 'before', false);`);

    await apply(update('todos', { id: ONE, title: 'after', done: true }, { id: ONE }));

    expect(await rowsOf('SELECT title, done FROM todos')).toEqual([{ title: 'after', done: true }]);
  });

  test('targets an update by the old primary key, which is what realtime sends', async () => {
    await pg.exec(`INSERT INTO todos VALUES ('${ONE}', 'keep', false), ('${TWO}', 'edit', false);`);

    await apply(update('todos', { id: TWO, title: 'edited', done: false }, { id: TWO }));

    expect(await rowsOf<{ title: string }>('SELECT title FROM todos ORDER BY title')).toEqual([
      { title: 'edited' },
      { title: 'keep' },
    ]);
  });

  test('deletes a row by its old primary key', async () => {
    await pg.exec(
      `INSERT INTO todos VALUES ('${ONE}', 'gone', false), ('${TWO}', 'stays', false);`,
    );

    await apply(remove('todos', { id: ONE }));

    expect(await rowsOf('SELECT title FROM todos')).toEqual([{ title: 'stays' }]);
  });

  test('quotes identifiers, so reserved words and spaces survive', async () => {
    await apply(insert('odd names', { group: 'a', select: 'b' }), 'group');
    await apply(update('odd names', { group: 'a', select: 'c' }, { group: 'a' }), 'group');

    expect(await rowsOf('SELECT "group", "select" FROM "odd names"')).toEqual([
      { group: 'a', select: 'c' },
    ]);
  });

  test('does not queue what it applied as an outgoing change', async () => {
    await trackTables(pg, [{ table: 'todos', primaryKey: 'id', columns: ['done', 'id', 'title'] }]);

    await apply(insert('todos', { id: ONE, title: 'from the server', done: false }));
    await apply(update('todos', { id: ONE, title: 'edited remotely', done: true }, { id: ONE }));
    await apply(remove('todos', { id: ONE }));

    // Without the suppression these would echo straight back to Supabase.
    expect(await rowsOf('SELECT id FROM supapower.changes')).toEqual([]);
  });

  test('leaves a local write alone, so tracking still works either side of it', async () => {
    await trackTables(pg, [{ table: 'todos', primaryKey: 'id', columns: ['done', 'id', 'title'] }]);

    await apply(insert('todos', { id: ONE, title: 'from the server', done: false }));
    await pg.exec(`INSERT INTO todos VALUES ('${TWO}', 'mine', false);`);

    const changes = await rowsOf<{ operation: string }>(
      'SELECT operation FROM supapower.changes ORDER BY id',
    );

    expect(changes).toEqual([{ operation: 'INSERT' }]);
  });

  test('applies nothing at all when the row could not be written', async () => {
    const failing = apply(insert('todos', { id: ONE, title: 'one', done: 'not a boolean' }));

    await expect(failing).rejects.toThrow();

    expect(await rowsOf('SELECT id FROM todos')).toEqual([]);
  });
});

describe('handleIncomingChange - a row with a local change still queued', () => {
  /** Queues an outgoing change the way the trigger would. */
  const queueLocalEdit = (table: string, row: Row) =>
    pg.exec(`
      INSERT INTO supapower.changes (table_name, tx_id, operation, new_data)
      VALUES ('${table}', pg_current_xact_id(), 'UPDATE', '${JSON.stringify(row)}'::jsonb);
    `);

  test('leaves the row alone rather than overwriting the local edit', async () => {
    await pg.exec(`INSERT INTO todos VALUES ('${ONE}', 'mine', false);`);
    await queueLocalEdit('todos', { id: ONE, title: 'mine', done: false });

    await apply(update('todos', { id: ONE, title: 'theirs', done: true }, { id: ONE }));

    expect(await rowsOf('SELECT title, done FROM todos')).toEqual([{ title: 'mine', done: false }]);
  });

  test('leaves a remote delete alone too', async () => {
    await pg.exec(`INSERT INTO todos VALUES ('${ONE}', 'mine', false);`);
    await queueLocalEdit('todos', { id: ONE, title: 'mine', done: false });

    await apply(remove('todos', { id: ONE }));

    expect(await rowsOf('SELECT title FROM todos')).toEqual([{ title: 'mine' }]);
  });

  test('applies to other rows of the same table', async () => {
    await pg.exec(
      `INSERT INTO todos VALUES ('${ONE}', 'mine', false), ('${TWO}', 'theirs', false);`,
    );
    await queueLocalEdit('todos', { id: ONE, title: 'mine', done: false });

    await apply(update('todos', { id: TWO, title: 'edited remotely', done: true }, { id: TWO }));

    expect(await rowsOf<{ title: string }>('SELECT title FROM todos ORDER BY title')).toEqual([
      { title: 'edited remotely' },
      { title: 'mine' },
    ]);
  });

  test('applies again once the local change has been pushed', async () => {
    await pg.exec(`INSERT INTO todos VALUES ('${ONE}', 'mine', false);`);
    await queueLocalEdit('todos', { id: ONE, title: 'mine', done: false });

    await apply(update('todos', { id: ONE, title: 'first try', done: true }, { id: ONE }));

    // What the outgoing sync does when the batch has gone upstream.
    await pg.exec(`DELETE FROM supapower.changes;`);

    await apply(update('todos', { id: ONE, title: 'second try', done: true }, { id: ONE }));

    expect(await rowsOf('SELECT title FROM todos')).toEqual([{ title: 'second try' }]);
  });
});

describe('handleIncomingChange - an update for a row that is not here', () => {
  test('inserts it, rather than matching nothing', async () => {
    // An insert missed while offline leaves the client without the row, and a
    // plain UPDATE would quietly affect nothing at all.
    await apply(update('todos', { id: ONE, title: 'edited remotely', done: true }, { id: ONE }));

    expect(await rowsOf('SELECT id, title FROM todos')).toEqual([
      { id: ONE, title: 'edited remotely' },
    ]);
  });
});
