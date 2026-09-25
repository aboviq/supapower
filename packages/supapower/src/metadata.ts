import type { PGliteInterface, Transaction } from '@electric-sql/pglite';

const keys = {
  syncedUser: 'SyncedUser',
  tableSyncState: 'TableSyncState',
  refreshRequests: 'RefreshRequests',
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
 * What is known about the last completed download of one table.
 *
 * Written for every table, whether or not it has a cursor: even with nothing
 * to page from, when the download finished decides whether the next start has
 * to repeat it. The cursor half only means anything next to the column it was
 * read from and the columns the download asked for - change either and the
 * same record answers a different question, which is what `stillApplies`
 * checks before either half is trusted.
 */
export interface TableSyncState {
  /** When the download finished, as local epoch milliseconds. */
  downloadedAt: number;
  /** The columns the download asked for, sorted. */
  columns: string[];
  /** The cursor column the table was downloaded with, if it has one. */
  cursor?: string;
  /** The highest value seen in that cursor column. */
  at?: string;
  /** The filter expression the download ran with, if it had one. */
  filter?: string;
  /** The refresh token the last completed download honoured, if `redownload()` was ever called for it. */
  refresh?: string;
}

/**
 * What is known about the last completed download of a table, or `null` if
 * it has never completed one.
 *
 * The value comes straight out of the remote table, so it is only ever
 * comparable to itself - see {@link TableSyncState}.
 *
 * @param table The table's qualified local name, e.g. `public.todos`.
 */
export const getTableSyncState = async (
  pg: PGliteInterface | Transaction,
  table: string,
): Promise<TableSyncState | null> => {
  const { rows } = await pg.sql<{ value: Record<string, TableSyncState> | null }>`
    SELECT value FROM supapower.metadata WHERE key = ${keys.tableSyncState}
  `;

  return rows[0]?.value?.[table] ?? null;
};

/**
 * Records what is known about the last completed download of a table.
 *
 * @param table The table's qualified local name, e.g. `public.todos`.
 */
export const setTableSyncState = async (
  pg: PGliteInterface | Transaction,
  table: string,
  state: TableSyncState,
): Promise<void> => {
  await pg.sql`
    INSERT INTO supapower.metadata (
      key,
      value
    )
    VALUES (
      ${keys.tableSyncState},
      ${JSON.stringify({ [table]: state })}
    )
    ON CONFLICT (key) DO UPDATE SET
      value = metadata.value || EXCLUDED.value;
  `;
};

/**
 * Forgets what was known about tables' last downloads, so the next start
 * pulls them whole.
 *
 * @param tables The tables' qualified local names, e.g. `public.todos`.
 */
export const clearTableSyncState = async (
  pg: PGliteInterface | Transaction,
  tables: string[],
): Promise<void> => {
  if (tables.length === 0) {
    return;
  }

  await pg.sql`
    UPDATE supapower.metadata
    SET value = value - ${tables}::text[]
    WHERE key = ${keys.tableSyncState}
  `;
};

/**
 * Asks for the named tables to be emptied and downloaded whole again.
 *
 * The token is opaque and only ever compared for equality against the one the
 * last completed download recorded, so it needs no clock: two tabs with skewed
 * clocks cannot talk each other's request out of happening.
 *
 * @param tables The tables' qualified local names, e.g. `public.todos`.
 */
export const requestTableRefresh = async (
  pg: PGliteInterface | Transaction,
  tables: readonly string[],
): Promise<void> => {
  if (tables.length === 0) {
    return;
  }

  const requested = Object.fromEntries(tables.map((table) => [table, crypto.randomUUID()]));

  await pg.sql`
    INSERT INTO supapower.metadata (
      key,
      value
    )
    VALUES (
      ${keys.refreshRequests},
      ${JSON.stringify(requested)}
    )
    ON CONFLICT (key) DO UPDATE SET
      value = metadata.value || EXCLUDED.value;
  `;
};

/** The refresh token last asked for on one table, if it was ever asked for. */
export const getRefreshRequest = async (
  pg: PGliteInterface | Transaction,
  table: string,
): Promise<string | undefined> => {
  const { rows } = await pg.sql<{ token: string | null }>`
    SELECT value ->> ${table} AS token
    FROM supapower.metadata
    WHERE key = ${keys.refreshRequests}
  `;

  return rows[0]?.token ?? undefined;
};
