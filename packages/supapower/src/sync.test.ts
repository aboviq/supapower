import { describe, expect, test } from 'bun:test';

import type { UnrecoverableUploadError } from './changes.js';
import { isUnrecoverableUploadError, SupapowerError } from './errors.js';
import { resolveTables, runOutgoingSync } from './sync.js';
import { waitFor } from './tests/async.js';
import { createChange } from './tests/changes.js';
import { asPGlite, createFakePGlite } from './tests/pglite.js';
import { asSupabaseClient, createFakeSupabase } from './tests/supabase.js';

describe('runOutgoingSync', () => {
  const tables = resolveTables(['todos']);

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
    const errors: unknown[] = [];

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
    const errors: unknown[] = [];

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
    expect(errors[0]).toBeInstanceOf(SupapowerError);
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
    const errors: unknown[] = [];
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
