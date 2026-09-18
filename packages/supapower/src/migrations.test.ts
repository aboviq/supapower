import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PGlite } from '@electric-sql/pglite';

import { isSupapowerError } from './errors.js';
import { readLocalColumns, runMigrations, trackTables } from './migrations.js';
import { resolveTables } from './sync.js';

let pg: PGlite;

beforeEach(async () => {
  pg = new PGlite();

  await pg.exec(`
    CREATE TABLE todos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text);
    CREATE TABLE tags (tag_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  `);

  await runMigrations(pg);
});

afterEach(async () => {
  await pg.close();
});

interface QueuedChange {
  table_name: string;
  operation: string;
  new_data: Record<string, string> | null;
  old_data: Record<string, string> | null;
}

const queue = async () => {
  const { rows } = await pg.query<QueuedChange>(
    'SELECT table_name, operation, new_data, old_data FROM supapower.changes ORDER BY id',
  );

  return rows;
};

describe('trackTables', () => {
  test('queues inserts, updates and deletes for a table keyed on "id"', async () => {
    await trackTables(pg, [
      { table: 'todos', localSchema: 'public', primaryKey: 'id', columns: ['id', 'title'] },
    ]);

    await pg.exec(`INSERT INTO todos (title) VALUES ('one'), ('two');`);
    await pg.exec(`UPDATE todos SET title = title || '!';`);
    await pg.exec(`DELETE FROM todos;`);

    const changes = await queue();

    expect(changes.map((change) => change.operation)).toEqual([
      'INSERT',
      'INSERT',
      'UPDATE',
      'UPDATE',
      'DELETE',
      'DELETE',
    ]);
  });

  test('queues updates for a table keyed on something other than "id"', async () => {
    await trackTables(pg, [
      { table: 'tags', localSchema: 'public', primaryKey: 'tag_id', columns: ['name', 'tag_id'] },
    ]);

    await pg.exec(`INSERT INTO tags (name) VALUES ('one'), ('two'), ('three');`);
    await pg.exec(`UPDATE tags SET name = name || '!';`);

    const updates = (await queue()).filter((change) => change.operation === 'UPDATE');

    expect(updates).toHaveLength(3);

    // The point of the test: each new row is paired with its own old row, not
    // with whichever one happened to come out of the tuplestore first.
    for (const update of updates) {
      expect(update.new_data?.['tag_id']).toBe(update.old_data?.['tag_id']);
      expect(update.new_data?.['name']).toBe(`${update.old_data?.['name']}!`);
    }
  });

  test('refuses a primary key the table does not have', async () => {
    // Silently recording nothing would be far worse than not starting: the
    // jsonb pairing would yield NULL on both sides and drop every update.
    const thrown = await trackTables(pg, [
      { table: 'tags', localSchema: 'public', primaryKey: 'id', columns: ['name', 'tag_id'] },
    ]).catch((error: unknown) => error);

    expect(isSupapowerError(thrown)).toBe(true);
    expect(isSupapowerError(thrown) && thrown.code).toBe('schema_mismatch');
    expect(String(thrown)).toContain('Table "public"."tags" has no column "id"');
  });

  test('refuses a table that does not exist in the local database', async () => {
    const thrown = await trackTables(pg, [
      { table: 'missing', localSchema: 'public', primaryKey: 'id', columns: [] },
    ]).catch((error: unknown) => error);

    expect(isSupapowerError(thrown)).toBe(true);
    expect(isSupapowerError(thrown) && thrown.code).toBe('schema_mismatch');
    expect(String(thrown)).toContain('"public"."missing" does not exist in the local database');
  });

  test('does not record a change made while applying an incoming one', async () => {
    await trackTables(pg, [
      { table: 'todos', localSchema: 'public', primaryKey: 'id', columns: ['id', 'title'] },
    ]);

    await pg.transaction(async (tx) => {
      await tx.exec(`SELECT set_config('supapower.applying', 'true', true)`);
      await tx.exec(`INSERT INTO todos (title) VALUES ('from the server');`);
    });

    expect(await queue()).toEqual([]);
  });

  test('is idempotent, as every tab runs it', async () => {
    await trackTables(pg, [
      { table: 'todos', localSchema: 'public', primaryKey: 'id', columns: ['id', 'title'] },
    ]);
    await runMigrations(pg);
    await trackTables(pg, [
      { table: 'todos', localSchema: 'public', primaryKey: 'id', columns: ['id', 'title'] },
    ]);

    await pg.exec(`INSERT INTO todos (title) VALUES ('once');`);

    expect(await queue()).toHaveLength(1);
  });
});

describe('trackTables - a table in another schema', () => {
  beforeEach(async () => {
    await pg.exec(`
      CREATE SCHEMA app;
      CREATE TABLE app.todos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text);
    `);
  });

  test('tracks it, and records the schema its trigger fired in', async () => {
    await trackTables(pg, [
      { table: 'todos', localSchema: 'app', primaryKey: 'id', columns: ['id', 'title'] },
    ]);

    await pg.exec(`INSERT INTO app.todos (title) VALUES ('one');`);

    const { rows } = await pg.query<{ schema_name: string; table_name: string }>(
      'SELECT schema_name, table_name FROM supapower.changes',
    );

    expect(rows).toEqual([{ schema_name: 'app', table_name: 'todos' }]);
  });

  test('leaves the same-named table in another schema untracked', async () => {
    await trackTables(pg, [
      { table: 'todos', localSchema: 'app', primaryKey: 'id', columns: ['id', 'title'] },
    ]);

    await pg.exec(`INSERT INTO public.todos (title) VALUES ('not synced');`);

    expect(await queue()).toEqual([]);
  });
});

describe('readLocalColumns', () => {
  test('reads each table from the schema it was asked for', async () => {
    await pg.exec(`
      CREATE SCHEMA app;
      CREATE TABLE app.todos (id uuid PRIMARY KEY, body text, pinned boolean);
    `);

    const columns = await readLocalColumns(
      pg,
      resolveTables(['todos', { table: 'todos', schema: 'app' }]),
    );

    expect(columns.get('"public"."todos"')).toEqual(['id', 'title']);
    expect(columns.get('"app"."todos"')).toEqual(['body', 'id', 'pinned']);
  });

  test('gives a table that is not there an empty column list', async () => {
    const columns = await readLocalColumns(pg, resolveTables([{ table: 'todos', schema: 'app' }]));

    expect(columns.get('"app"."todos"')).toEqual([]);
  });
});
