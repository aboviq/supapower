import { describe, expect, test } from 'bun:test';

import { resolveTables, runIncomingSync } from './sync.js';
import { settle, waitFor } from './tests/async.js';
import { asPGlite, createFakePGlite } from './tests/pglite.js';
import { asSupabaseClient, createFakeSupabase } from './tests/supabase.js';

const tables = resolveTables(['todos', { table: 'tags', primaryKey: 'tag_id' }]);

const insert = (table: string, row: Record<string, unknown>) => ({
  eventType: 'INSERT' as const,
  schema: 'public',
  table,
  commit_timestamp: '2026-01-01T00:00:00.000Z',
  new: row,
  old: {},
});

const ran = (pg: { statements: string[] }, fragment: string) =>
  pg.statements.some((statement) => statement.includes(fragment));

describe('runIncomingSync', () => {
  test('subscribes one channel to every table it is given', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = runIncomingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
    });

    expect(supabase.channels).toHaveLength(1);
    expect(supabase.openChannel?.bindings).toEqual(['public.todos', 'public.tags']);
    expect(supabase.openChannel?.subscribed).toBe(true);

    controller.abort();
    await running;
  });

  test('opens no channel when there is nothing the user may see', async () => {
    const supabase = createFakeSupabase();

    await runIncomingSync({
      pg: asPGlite(createFakePGlite()),
      supabase: asSupabaseClient(supabase),
      tables: new Map(),
      signal: new AbortController().signal,
    });

    expect(supabase.channels).toEqual([]);
  });

  test('applies a remote change locally with the trigger suppressed', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = runIncomingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
    });

    supabase.openChannel?.emit(insert('todos', { id: 1, title: 'from another device' }));

    expect(await waitFor(() => ran(pg, 'INSERT INTO "public"."todos"'))).toBe(true);
    // Without this the local write would be queued straight back as an
    // outgoing change and echo around forever.
    expect(ran(pg, "set_config('supapower.applying', 'true', true)")).toBe(true);
    // Applying a change and moving the watermark are one transaction.
    expect(ran(pg, 'INSERT INTO supapower.metadata')).toBe(true);

    controller.abort();
    await running;
  });

  test('applies changes in the order they were broadcast', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = runIncomingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
    });

    // Delivered back to back, as realtime would: the handler is async, so
    // without chaining these two could interleave.
    supabase.openChannel?.emit(insert('todos', { id: 1, title: 'first' }));
    supabase.openChannel?.emit(insert('tags', { tag_id: 2, name: 'second' }));

    expect(await waitFor(() => ran(pg, 'INSERT INTO "public"."tags"'))).toBe(true);

    const applied = pg.statements.filter((statement) =>
      statement.startsWith('INSERT INTO "public"'),
    );

    expect(applied[0]).toContain('"todos"');
    expect(applied[1]).toContain('"tags"');

    controller.abort();
    await running;
  });

  test('closes the channel when the signal aborts', async () => {
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = runIncomingSync({
      pg: asPGlite(createFakePGlite()),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
    });

    const channel = supabase.openChannel;

    expect(channel?.removed).toBe(false);

    controller.abort();
    await running;

    expect(channel?.removed).toBe(true);
    expect(supabase.openChannel).toBeUndefined();
  });

  test('ignores a change that arrives after the signal aborted', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = runIncomingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
    });

    const channel = supabase.openChannel;

    controller.abort();
    channel?.emit(insert('todos', { id: 1, title: 'too late' }));

    await running;
    await settle();

    expect(pg.statements).toEqual([]);
  });

  test('reports channel trouble without tearing the subscription down', async () => {
    const supabase = createFakeSupabase();
    const controller = new AbortController();
    const errors: unknown[] = [];

    const running = runIncomingSync({
      pg: asPGlite(createFakePGlite()),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      onError: (error) => errors.push(error),
    });

    const channel = supabase.openChannel;

    channel?.report('TIMED_OUT');

    expect(errors).toHaveLength(1);
    // realtime-js rejoins on its own; tearing it down here would fight that.
    expect(channel?.removed).toBe(false);

    controller.abort();
    await running;
  });
});
