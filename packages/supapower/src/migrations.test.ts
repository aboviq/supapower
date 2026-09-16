import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PGlite } from '@electric-sql/pglite';

import { isSupapowerError } from './errors.js';
import { runMigrations, trackTables } from './migrations.js';

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
    await trackTables(pg, [{ table: 'todos', primaryKey: 'id' }]);

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
    await trackTables(pg, [{ table: 'tags', primaryKey: 'tag_id' }]);

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
    const thrown = await trackTables(pg, [{ table: 'tags', primaryKey: 'id' }]).catch(
      (error: unknown) => error,
    );

    expect(isSupapowerError(thrown)).toBe(true);
    expect(isSupapowerError(thrown) && thrown.code).toBe('schema_mismatch');
    expect(String(thrown)).toContain('Table "tags" has no column "id"');
  });

  test('does not record a change made while applying an incoming one', async () => {
    await trackTables(pg, [{ table: 'todos', primaryKey: 'id' }]);

    await pg.transaction(async (tx) => {
      await tx.exec(`SELECT set_config('supapower.applying', 'true', true)`);
      await tx.exec(`INSERT INTO todos (title) VALUES ('from the server');`);
    });

    expect(await queue()).toEqual([]);
  });

  test('is idempotent, as every tab runs it', async () => {
    await trackTables(pg, [{ table: 'todos', primaryKey: 'id' }]);
    await runMigrations(pg);
    await trackTables(pg, [{ table: 'todos', primaryKey: 'id' }]);

    await pg.exec(`INSERT INTO todos (title) VALUES ('once');`);

    expect(await queue()).toHaveLength(1);
  });
});
