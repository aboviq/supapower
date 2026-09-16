import { describe, expect, test } from 'bun:test';

import type { UnrecoverableUploadError } from './changes.js';
import { isUnrecoverableUploadError, type SupapowerError } from './errors.js';
import { runOutgoingSync } from './sync.js';
import { waitFor } from './tests/async.js';
import { createChange } from './tests/changes.js';
import { asPGlite, createFakePGlite } from './tests/pglite.js';
import { asSupabaseClient, createFakeSupabase } from './tests/supabase.js';
import { resolveTablesWith } from './tests/tables.js';

const remove = (txId: string, id: number) =>
  createChange(txId, id, {
    operation: 'DELETE',
    new_data: null,
    old_data: { id, title: 'gone' },
  });

describe('runOutgoingSync', () => {
  const tables = resolveTablesWith(['todos'], { todos: ['id', 'title'] });

  test('pushes a batch and clears it from the queue', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1), createChange('100', 2)] });
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
    });

    expect(await waitFor(() => pg.queue.length === 0)).toBe(true);
    controller.abort();
    await running;

    expect(supabase.calls).toEqual(['upsert:todos', 'upsert:todos']);
  });

  test('discards a batch Supabase will never accept, by default', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1), createChange('100', 2)] });
    const supabase = createFakeSupabase({
      respond: () => ({ code: '23505', message: 'duplicate key' }),
    });
    const controller = new AbortController();
    const errors: SupapowerError[] = [];

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      onError: (error) => errors.push(error),
    });

    expect(await waitFor(() => pg.queue.length === 0)).toBe(true);
    controller.abort();
    await running;

    // The first change was rejected, so the rest of the batch is never tried.
    expect(supabase.calls).toEqual(['upsert:todos']);
    // Discarding is not a sync failure, so the retry path stays untouched.
    expect(errors).toEqual([]);
  });

  test('keeps a batch queued when the failure is transient', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1)] });
    const supabase = createFakeSupabase({ respond: () => ({ code: '08006', message: 'offline' }) });
    const controller = new AbortController();
    const errors: SupapowerError[] = [];

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      onError: (error) => errors.push(error),
    });

    expect(await waitFor(() => errors.length > 0)).toBe(true);
    controller.abort();
    await running;

    expect(pg.queue).toHaveLength(1);
    expect(errors[0]?.code).toBe('upload_failed');
  });

  test('hands a rejected batch to a custom handler', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1), createChange('100', 2)] });
    const supabase = createFakeSupabase({
      respond: (call) => (call === 0 ? null : { code: '42501', message: 'row-level security' }),
    });
    const controller = new AbortController();
    const seen: UnrecoverableUploadError[] = [];

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      onUnrecoverableError: async (context) => {
        seen.push(context);
        await context.commit();
      },
    });

    expect(await waitFor(() => pg.queue.length === 0)).toBe(true);
    controller.abort();
    await running;

    const [context] = seen;

    expect(seen).toHaveLength(1);
    expect(context?.batch).toHaveLength(2);
    expect(context?.change.id).toBe(2); // the second change is the one that failed
    expect(isUnrecoverableUploadError(context?.error)).toBe(true);
  });

  test('retries when the handler keeps the batch instead of committing', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1)] });
    const supabase = createFakeSupabase({
      respond: () => ({ code: '23502', message: 'not null' }),
    });
    const controller = new AbortController();
    const errors: SupapowerError[] = [];
    let handled = 0;

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      onUnrecoverableError: () => {
        handled += 1; // deliberately does not commit
      },
      onError: (error) => errors.push(error),
    });

    expect(await waitFor(() => errors.length > 0)).toBe(true);
    controller.abort();
    await running;

    expect(handled).toBe(1);
    expect(pg.queue).toHaveLength(1);
  });
});

describe('runOutgoingSync - a DELETE that matched nothing', () => {
  const tables = resolveTablesWith(['todos'], { todos: ['id', 'title'] });

  test('reports it and keeps the queue moving', async () => {
    const pg = createFakePGlite({ changes: [remove('100', 1)] });
    // What row-level security refusing a delete looks like: the row is filtered
    // out of the USING clause rather than the request failing.
    const supabase = createFakeSupabase({ deletedRows: () => 0 });
    const controller = new AbortController();
    const errors: SupapowerError[] = [];

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      onError: (error) => errors.push(error),
    });

    expect(await waitFor(() => pg.queue.length === 0)).toBe(true);
    controller.abort();
    await running;

    expect(errors).toHaveLength(1);
    // No narrowing needed: everything reaching onError is a SupapowerError.
    expect(errors[0]?.code).toBe('delete_ignored');
  });

  test('says nothing when a row was actually removed', async () => {
    const pg = createFakePGlite({ changes: [remove('100', 1)] });
    const supabase = createFakeSupabase();
    const controller = new AbortController();
    const errors: SupapowerError[] = [];

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      onError: (error) => errors.push(error),
    });

    expect(await waitFor(() => pg.queue.length === 0)).toBe(true);
    controller.abort();
    await running;

    expect(errors).toEqual([]);
  });

  test('says nothing when the server reported no count at all', async () => {
    const pg = createFakePGlite({ changes: [remove('100', 1)] });
    const supabase = createFakeSupabase({ deletedRows: () => null });
    const controller = new AbortController();
    const errors: SupapowerError[] = [];

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      onError: (error) => errors.push(error),
    });

    expect(await waitFor(() => pg.queue.length === 0)).toBe(true);
    controller.abort();
    await running;

    expect(errors).toEqual([]);
  });
});
