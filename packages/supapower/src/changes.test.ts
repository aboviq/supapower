import { describe, expect, test } from 'bun:test';

import { getNextSyncTransaction } from './changes.js';
import { createChange } from './tests/changes.js';
import { asPGlite, createFakePGlite } from './tests/pglite.js';

const deletes = (statements: string[]) =>
  statements.filter((statement) => statement.startsWith('DELETE FROM supapower.changes'));

describe('getNextSyncTransaction', () => {
  test('yields every change sharing the oldest transaction id', async () => {
    const pg = createFakePGlite({
      changes: [createChange('100', 1), createChange('100', 2), createChange('101', 3)],
    });

    const transactions = getNextSyncTransaction(asPGlite(pg), new AbortController().signal);
    const { value } = await transactions.next();

    expect(value?.batch.map((change) => change.id)).toEqual([1, 2]);

    await transactions.return(undefined);
  });

  test('commit removes the whole batch and leaves the next one queued', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1), createChange('101', 2)] });

    const transactions = getNextSyncTransaction(asPGlite(pg), new AbortController().signal);
    const { value } = await transactions.next();

    await value?.commit();

    expect(pg.queue.map((change) => change.id)).toEqual([2]);

    await transactions.return(undefined);
  });

  test('overlapping commits share a single delete', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1)] });

    const transactions = getNextSyncTransaction(asPGlite(pg), new AbortController().signal);
    const { value } = await transactions.next();

    // Started together on purpose: a guard that only flips after its own await
    // would let both through.
    await Promise.all([value?.commit(), value?.commit()]);
    await value?.commit();

    expect(deletes(pg.statements)).toHaveLength(1);
    expect(pg.queue).toEqual([]);

    await transactions.return(undefined);
  });

  test('ends without querying once the signal is aborted', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1)] });

    const transactions = getNextSyncTransaction(asPGlite(pg), AbortSignal.abort());

    expect(await transactions.next()).toEqual({ done: true, value: undefined });
    expect(pg.statements).toEqual([]);
  });
});
