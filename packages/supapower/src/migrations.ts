import type { PGliteInterface } from '@electric-sql/pglite';
import { identifier, raw } from '@electric-sql/pglite/template';

import { CHANGES_CHANNEL } from './constants.js';
import { SupapowerError } from './errors.js';
import type { ResolvedTableConfig } from './types.js';
import { escapeIdentifier } from './utils.js';

/** The part of a table's configuration the triggers need. */
export interface TrackedTable {
  table: string;
  /** The schema the table lives in locally - the only side triggers exist on. */
  localSchema: string;
  primaryKey: string;
  /** The columns the table actually has locally, from {@link readLocalColumns}. */
  columns: readonly string[];
}

/**
 * Reads the columns each table actually has in the local database.
 *
 * The local schema is the application's, not Supapower's, and it lags behind
 * the remote one whenever the server deploys first. Knowing what is there is
 * what lets an incoming row be trimmed to fit instead of failing to apply.
 *
 * Only the local side of a table is of any interest here, so a config's
 * `schema` is ignored in favor of its `localSchema`.
 *
 * @param tables The resolved configuration, as `resolveTables` keyed it.
 * @returns The columns per table, keyed by {@link escapeIdentifier} and
 *   sorted, so two readings compare directly.
 */
export const readLocalColumns = async (
  pg: PGliteInterface,
  tables: Map<string, ResolvedTableConfig>,
): Promise<Map<string, string[]>> => {
  const columns = new Map<string, string[]>();
  const schemas: string[] = [];
  const names: string[] = [];

  for (const [key, { localSchema, table }] of tables) {
    columns.set(key, []);
    schemas.push(localSchema);
    names.push(table);
  }

  if (names.length === 0) {
    return columns;
  }

  const { rows } = await pg.sql<{
    table_schema: string;
    table_name: string;
    column_name: string;
  }>`
    SELECT table_schema, table_name, column_name FROM information_schema.columns
    WHERE (table_schema, table_name) IN (
      SELECT * FROM unnest(${schemas}::text[], ${names}::text[])
    )
    ORDER BY table_schema, table_name, column_name
  `;

  for (const { table_schema, table_name, column_name } of rows) {
    columns.get(escapeIdentifier(table_schema, table_name))?.push(column_name);
  }

  return columns;
};

export const runMigrations = async (pg: PGliteInterface): Promise<void> => {
  await pg.transaction(async (tx) => {
    // Create the schema:
    await tx.sql`
      CREATE SCHEMA IF NOT EXISTS supapower;
    `;

    // Create the changes table:
    await tx.sql`
      CREATE TABLE IF NOT EXISTS supapower.changes (
        id BIGSERIAL PRIMARY KEY,
        schema_name TEXT NOT NULL DEFAULT 'public',
        table_name TEXT NOT NULL,
        tx_id XID8 NOT NULL,
        operation TEXT NOT NULL,
        new_data JSONB,
        old_data JSONB,
        changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      );
    `;

    await tx.sql`
      CREATE INDEX IF NOT EXISTS supapower_idx_changes_tx_id ON supapower.changes (tx_id);
    `;

    // Create track_table_changes trigger:
    await tx.sql`
      CREATE OR REPLACE FUNCTION supapower.track_table_changes() RETURNS trigger AS $$
      DECLARE
        -- The tracked table's primary key, passed in by CREATE TRIGGER.
        primary_key TEXT := TG_ARGV[0];
      BEGIN
        IF current_setting('supapower.applying', true) = 'true' THEN
          RETURN NULL;
        END IF;

        IF TG_OP = 'INSERT' THEN
          INSERT INTO supapower.changes (
            schema_name,
            table_name,
            tx_id,
            operation,
            new_data,
            old_data
          )
          SELECT
            TG_TABLE_SCHEMA,
            TG_TABLE_NAME,
            pg_current_xact_id(),
            'INSERT',
            to_jsonb(n),
            NULL
          FROM
            new_table n;

        ELSIF TG_OP = 'UPDATE' THEN
          INSERT INTO supapower.changes (
            schema_name,
            table_name,
            tx_id,
            operation,
            new_data,
            old_data
          )
          SELECT
            TG_TABLE_SCHEMA,
            TG_TABLE_NAME,
            pg_current_xact_id(),
            'UPDATE',
            to_jsonb(n),
            to_jsonb(o)
          FROM
            new_table n
            JOIN old_table o ON
              to_jsonb(o) ->> primary_key = to_jsonb(n) ->> primary_key;

        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO supapower.changes (
            schema_name,
            table_name,
            tx_id,
            operation,
            new_data,
            old_data
          )
          SELECT
            TG_TABLE_SCHEMA,
            TG_TABLE_NAME,
            pg_current_xact_id(),
            'DELETE',
            NULL,
            to_jsonb(o)
          FROM
            old_table o;
        END IF;

        -- Wake whichever tab is currently draining the outgoing queue.
        PERFORM pg_notify(${raw`'${CHANGES_CHANNEL}'`}, '');

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `;

    // Create metadata table:
    await tx.sql`
      CREATE TABLE IF NOT EXISTS supapower.metadata (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `;
  });
};

/**
 * Fails loudly when the configured primary key is not a column of the table.
 *
 * The trigger pairs rows through `to_jsonb(row) ->> primary_key`, and a key
 * that is not there yields `NULL` on both sides of the join. `NULL = NULL` is
 * false, so every `UPDATE` would go unrecorded without a single error to say
 * so - which is far worse than refusing to start.
 */
const assertPrimaryKey = ({ table, localSchema, primaryKey, columns }: TrackedTable) => {
  if (!columns.includes(primaryKey)) {
    throw new SupapowerError(
      `Table ${escapeIdentifier(localSchema, table)} has no column "${primaryKey}" to use as its primary key`,
      { code: 'schema_mismatch' },
    );
  }
};

export const trackTables = async (
  pg: PGliteInterface,
  tables: readonly TrackedTable[],
): Promise<void> => {
  await Promise.all(
    tables.map(async (tracked) => {
      const { table, localSchema, primaryKey } = tracked;

      assertPrimaryKey(tracked);

      // A trigger argument is a literal, not a parameter, so it is escaped by
      // hand. `assertPrimaryKey` has already established it is a real column.
      const key = raw`'${primaryKey.replaceAll("'", "''")}'`;

      // Two quoted parts rather than one identifier: `identifier` escapes what
      // it is given as a single name, so "app.todos" would come out as one.
      const relation = raw`${escapeIdentifier(localSchema, table)}`;

      await pg.transaction(async (tx) => {
        await tx.sql`
          CREATE OR REPLACE TRIGGER ${identifier`supapower_change_trigger_insert_${table}`}
          AFTER INSERT ON ${relation}
          REFERENCING NEW TABLE AS new_table
          FOR EACH STATEMENT EXECUTE FUNCTION supapower.track_table_changes(${key});
        `;

        await tx.sql`
          CREATE OR REPLACE TRIGGER ${identifier`supapower_change_trigger_update_${table}`}
          AFTER UPDATE ON ${relation}
          REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
          FOR EACH STATEMENT EXECUTE FUNCTION supapower.track_table_changes(${key});
        `;

        await tx.sql`
          CREATE OR REPLACE TRIGGER ${identifier`supapower_change_trigger_delete_${table}`}
          AFTER DELETE ON ${relation}
          REFERENCING OLD TABLE AS old_table
          FOR EACH STATEMENT EXECUTE FUNCTION supapower.track_table_changes(${key});
        `;
      });
    }),
  );
};
