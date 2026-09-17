import { describe, expect, test } from 'bun:test';

import type { UnrecoverableUploadError } from './changes.js';
import { isUnrecoverableUploadError, type SupapowerError } from './errors.js';
import { createSupapowerEvents } from './events.js';
import { runOutgoingSync } from './sync.js';
import { waitFor } from './tests/async.js';
import { createChange } from './tests/changes.js';
import { asPGlite, createFakePGlite } from './tests/pglite.js';
import { asSupabaseClient, createFakeSupabase, type FakeSupabase } from './tests/supabase.js';
import { resolveTablesWith } from './tests/tables.js';

const edit = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  createChange('100', 1, { operation: 'UPDATE', old_data: before, new_data: after });

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

  test('dispatches uploadStart before and uploadFinish after a committed batch', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1), createChange('100', 2)] });
    const supabase = createFakeSupabase();
    const controller = new AbortController();
    const events = createSupapowerEvents();
    const seen: string[] = [];

    events.addEventListener('uploadStart', () => seen.push('uploadStart'));
    events.addEventListener('uploadFinish', () => seen.push('uploadFinish'));

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      events,
    });

    expect(await waitFor(() => pg.queue.length === 0)).toBe(true);
    controller.abort();
    await running;

    // Both changes share a `tx_id`, so they are one batch: one pair of events.
    expect(seen).toEqual(['uploadStart', 'uploadFinish']);
  });

  test('does not dispatch uploadFinish for a batch that stays queued after a transient failure', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1)] });
    const supabase = createFakeSupabase({ respond: () => ({ code: '08006', message: 'offline' }) });
    const controller = new AbortController();
    const events = createSupapowerEvents();
    const errors: SupapowerError[] = [];
    const finishes: Event[] = [];

    events.addEventListener('error', (event) => errors.push(event.error));
    events.addEventListener('uploadFinish', (event) => finishes.push(event));

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      events,
    });

    expect(await waitFor(() => errors.length > 0)).toBe(true);
    controller.abort();
    await running;

    expect(finishes).toEqual([]);
  });

  test('discards a batch Supabase will never accept, by default', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1), createChange('100', 2)] });
    const supabase = createFakeSupabase({
      respond: () => ({ code: '23505', message: 'duplicate key' }),
    });
    const controller = new AbortController();
    const errors: SupapowerError[] = [];
    const events = createSupapowerEvents();

    events.addEventListener('error', (event) => errors.push(event.error));

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      events,
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
    const events = createSupapowerEvents();

    events.addEventListener('error', (event) => errors.push(event.error));

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      events,
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
    const events = createSupapowerEvents();
    let handled = 0;

    events.addEventListener('error', (event) => errors.push(event.error));

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      onUnrecoverableError: () => {
        handled += 1; // deliberately does not commit
      },
      events,
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
    const events = createSupapowerEvents();

    events.addEventListener('error', (event) => errors.push(event.error));

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      events,
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
    const events = createSupapowerEvents();

    events.addEventListener('error', (event) => errors.push(event.error));

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      events,
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
    const events = createSupapowerEvents();

    events.addEventListener('error', (event) => errors.push(event.error));

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      events,
    });

    expect(await waitFor(() => pg.queue.length === 0)).toBe(true);
    controller.abort();
    await running;

    expect(errors).toEqual([]);
  });
});

describe('runOutgoingSync - what an update sends', () => {
  const tables = resolveTablesWith(['todos'], { todos: ['id', 'done', 'title'] });

  const drain = async (
    pg: ReturnType<typeof createFakePGlite>,
    supabase: ReturnType<typeof createFakeSupabase>,
  ) => {
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
  };

  test('sends only the columns that changed', async () => {
    const pg = createFakePGlite({
      changes: [
        edit({ id: 1, title: 'one', done: false }, { id: 1, title: 'edited', done: false }),
      ],
    });
    const supabase = createFakeSupabase();

    await drain(pg, supabase);

    // Sending "done" as well would replace whatever somebody else did to it.
    expect(supabase.calls).toEqual(['update:todos']);
    expect(supabase.payloads[0]).toEqual({ title: 'edited' });
  });

  test('ignores a column edited back to what it was', async () => {
    const pg = createFakePGlite({
      changes: [edit({ id: 1, title: 'one', done: true }, { id: 1, title: 'one', done: false })],
    });
    const supabase = createFakeSupabase();

    await drain(pg, supabase);

    expect(supabase.payloads[0]).toEqual({ done: false });
  });

  test('sends nothing at all when no column moved', async () => {
    const pg = createFakePGlite({
      changes: [edit({ id: 1, title: 'one' }, { id: 1, title: 'one' })],
    });
    const supabase = createFakeSupabase();

    await drain(pg, supabase);

    expect(supabase.calls).toEqual([]);
    expect(pg.queue).toEqual([]);
  });

  test('compares nested values without tripping over key order', async () => {
    const pg = createFakePGlite({
      changes: [edit({ id: 1, meta: { a: 1, b: 2 } }, { id: 1, meta: { a: 1, b: 2 } })],
    });
    const supabase = createFakeSupabase();

    await drain(pg, supabase);

    // jsonb normalizes key order on both sides, so these really are equal.
    expect(supabase.calls).toEqual([]);
  });

  test('reports an update that matched nothing, and keeps the queue moving', async () => {
    const pg = createFakePGlite({
      changes: [
        edit({ id: 1, title: 'one', done: false }, { id: 1, title: 'edited', done: false }),
      ],
    });
    // Either the row is gone upstream, or row-level security is hiding it.
    const supabase = createFakeSupabase({ updatedRows: () => 0 });
    const errors: SupapowerError[] = [];
    const controller = new AbortController();
    const events = createSupapowerEvents();

    events.addEventListener('error', (event) => errors.push(event.error));

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      events,
    });

    expect(await waitFor(() => pg.queue.length === 0)).toBe(true);
    controller.abort();
    await running;

    expect(supabase.calls).toEqual(['update:todos']);
    expect(errors[0]?.code).toBe('update_ignored');
  });

  test('still sends the whole row for an insert', async () => {
    const pg = createFakePGlite({ changes: [createChange('100', 1)] });
    const supabase = createFakeSupabase();

    await drain(pg, supabase);

    expect(supabase.calls).toEqual(['upsert:todos']);
    expect(supabase.payloads[0]).toEqual({ id: 1, title: 'write tests' });
  });
});

describe('runOutgoingSync - tables outside "public"', () => {
  const tables = resolveTablesWith(
    [
      { table: 'todos', schema: 'app' },
      { table: 'notes', schema: 'app', localSchema: 'mirror' },
    ],
    { 'app.todos': ['id', 'title'], 'mirror.notes': ['id', 'title'] },
  );

  const drain = async (pg: ReturnType<typeof createFakePGlite>, supabase: FakeSupabase) => {
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
  };

  test('pushes a change to the schema the table was configured for', async () => {
    const pg = createFakePGlite({
      changes: [createChange('100', 1, { schema_name: 'app', table_name: 'todos' })],
    });
    const supabase = createFakeSupabase();

    await drain(pg, supabase);

    expect(supabase.calls).toEqual(['upsert:todos']);
    expect(supabase.schemas).toEqual(['app']);
  });

  test('pushes a change made in the local schema to the remote one', async () => {
    const pg = createFakePGlite({
      changes: [createChange('100', 1, { schema_name: 'mirror', table_name: 'notes' })],
    });
    const supabase = createFakeSupabase();

    await drain(pg, supabase);

    // Queued as "mirror.notes" locally, and it belongs in "app" upstream.
    expect(supabase.calls).toEqual(['upsert:notes']);
    expect(supabase.schemas).toEqual(['app']);
  });

  test('leaves a same-named table in another schema queued', async () => {
    const pg = createFakePGlite({
      changes: [
        createChange('100', 1, { schema_name: 'public', table_name: 'todos' }),
        createChange('101', 2, { schema_name: 'app', table_name: 'todos' }),
      ],
    });
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = runOutgoingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
    });

    expect(await waitFor(() => pg.queue.length === 1)).toBe(true);
    controller.abort();
    await running;

    // "public.todos" is not configured, so it is a different table entirely.
    expect(supabase.calls).toEqual(['upsert:todos']);
    expect(pg.queue.map((change) => change.schema_name)).toEqual(['public']);
  });
});
