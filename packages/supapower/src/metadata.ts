import type { PGliteInterface, Transaction } from '@electric-sql/pglite';

import { executeInTransaction } from './utils.js';

const keys = {
  syncedIncomingAt: 'SyncedIncomingAt',
  syncedUser: 'SyncedUser',
} as const;

export const setSyncedIncomingAt = async (
  pg: PGliteInterface | Transaction,
  table: string,
  syncedIncomingAt: Date,
): Promise<void> => {
  await executeInTransaction(pg, async (tx) => {
    await tx.sql`
      INSERT INTO supapower.metadata (
        key,
        value
      )
      VALUES (
        ${keys.syncedIncomingAt},
        ${JSON.stringify({ [table]: syncedIncomingAt.toISOString() })}
      )
      ON CONFLICT (key) DO UPDATE SET
        value = metadata.value || EXCLUDED.value;
    `;
  });
};

/**
 * Forgets the watermarks for tables whose contents were dropped.
 *
 * A watermark left behind after a truncate claims the table is up to date with
 * a remote change it no longer holds.
 */
export const clearSyncedIncomingAt = async (
  pg: PGliteInterface | Transaction,
  tables: string[],
): Promise<void> => {
  if (tables.length === 0) {
    return;
  }

  await pg.sql`
    UPDATE supapower.metadata
    SET value = value - ${tables}::text[]
    WHERE key = ${keys.syncedIncomingAt}
  `;
};

/**
 * The user the local data was last synced for, or `null` when it was synced
 * with nobody signed in.
 *
 * Kept in the database rather than in memory so a reload can tell whose rows
 * are sitting in the local tables.
 */
export const getSyncedUser = async (pg: PGliteInterface | Transaction): Promise<string | null> => {
  const { rows } = await pg.sql<{ value: string | null }>`
    SELECT value FROM supapower.metadata WHERE key = ${keys.syncedUser}
  `;

  return rows[0]?.value ?? null;
};

/** Records who the local data now belongs to. */
export const setSyncedUser = async (
  pg: PGliteInterface | Transaction,
  user: string | null,
): Promise<void> => {
  await pg.sql`
    INSERT INTO supapower.metadata (
      key,
      value
    )
    VALUES (
      ${keys.syncedUser},
      ${JSON.stringify(user)}
    )
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value;
  `;
};
