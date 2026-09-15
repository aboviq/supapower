import type { PGliteInterface } from '@electric-sql/pglite';
import { identifier } from '@electric-sql/pglite/template';

import { CHANGES_CHANNEL } from './constants.js';

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
              o.id = n.id;

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
        PERFORM pg_notify(${CHANGES_CHANNEL}, '');

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

export const trackTables = async (pg: PGliteInterface, tableNames: string[]): Promise<void> => {
  await Promise.all(
    tableNames.map(async (table) => {
      await pg.transaction(async (tx) => {
        await tx.sql`
          CREATE OR REPLACE TRIGGER ${identifier`supapower_change_trigger_insert_${table}`}
          AFTER INSERT ON ${identifier`${table}`}
          REFERENCING NEW TABLE AS new_table
          FOR EACH STATEMENT EXECUTE FUNCTION supapower.track_table_changes();
        `;

        await tx.sql`
          CREATE OR REPLACE TRIGGER ${identifier`supapower_change_trigger_update_${table}`}
          AFTER UPDATE ON ${identifier`${table}`}
          REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
          FOR EACH STATEMENT EXECUTE FUNCTION supapower.track_table_changes();
        `;

        await tx.sql`
          CREATE OR REPLACE TRIGGER ${identifier`supapower_change_trigger_delete_${table}`}
          AFTER DELETE ON ${identifier`${table}`}
          REFERENCING OLD TABLE AS old_table
          FOR EACH STATEMENT EXECUTE FUNCTION supapower.track_table_changes();
        `;
      });
    }),
  );
};
