import type { PGliteInterface, Transaction } from '@electric-sql/pglite';

import { executeInTransaction } from './utils.js';

const keys = {
  syncedIncomingAt: 'SyncedIncomingAt',
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
