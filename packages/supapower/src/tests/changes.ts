import type { ChangeRow } from '../changes.js';

/**
 * Builds a queued change, defaulting to an INSERT on `public.todos`.
 *
 * Changes sharing a `txId` form one batch, the same way the change trigger
 * groups them by `tx_id`.
 */
export function createChange(
  txId: string,
  id: number,
  overrides: Partial<ChangeRow> = {},
): ChangeRow {
  return {
    id,
    tx_id: txId,
    schema_name: 'public',
    table_name: 'todos',
    operation: 'INSERT',
    new_data: { id, title: 'write tests' },
    old_data: null,
    changed_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ChangeRow;
}
