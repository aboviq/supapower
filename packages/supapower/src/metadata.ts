import type { PGliteInterface, Transaction } from '@electric-sql/pglite';

const keys = {
  syncedUser: 'SyncedUser',
  syncedCursorAt: 'SyncedCursorAt',
} as const;

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

/**
 * How far a table has been downloaded, and what that is worth.
 *
 * A bare value would be underspecified. It only means anything next to the
 * column it was read from and the columns the download asked for: change
 * either and the same timestamp answers a different question.
 */
export interface CursorWatermark {
  /** The highest value seen in the cursor column. */
  at: string;
  /** The column that value was read from. */
  cursor: string;
  /** The columns the download asked for, sorted. */
  columns: string[];
}

/**
 * How far a table has been downloaded, or `null` if it never has.
 *
 * The value comes straight out of the remote table, so it is only ever
 * comparable to itself - see {@link CursorWatermark}.
 */
export const getSyncedCursorAt = async (
  pg: PGliteInterface | Transaction,
  table: string,
): Promise<CursorWatermark | null> => {
  const { rows } = await pg.sql<{ value: Record<string, CursorWatermark> | null }>`
    SELECT value FROM supapower.metadata WHERE key = ${keys.syncedCursorAt}
  `;

  return rows[0]?.value?.[table] ?? null;
};

/** Records how far a table has been downloaded, and under what. */
export const setSyncedCursorAt = async (
  pg: PGliteInterface | Transaction,
  table: string,
  watermark: CursorWatermark,
): Promise<void> => {
  await pg.sql`
    INSERT INTO supapower.metadata (
      key,
      value
    )
    VALUES (
      ${keys.syncedCursorAt},
      ${JSON.stringify({ [table]: watermark })}
    )
    ON CONFLICT (key) DO UPDATE SET
      value = metadata.value || EXCLUDED.value;
  `;
};

/** Forgets how far tables were downloaded, so the next start pulls them whole. */
export const clearSyncedCursorAt = async (
  pg: PGliteInterface | Transaction,
  tables: string[],
): Promise<void> => {
  if (tables.length === 0) {
    return;
  }

  await pg.sql`
    UPDATE supapower.metadata
    SET value = value - ${tables}::text[]
    WHERE key = ${keys.syncedCursorAt}
  `;
};
