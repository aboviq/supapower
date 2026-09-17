import { describe, expect, test } from 'bun:test';

import type { SupapowerError } from './errors.js';
import { runIncomingSync } from './sync.js';
import { settle, waitFor } from './tests/async.js';
import { asPGlite, createFakePGlite } from './tests/pglite.js';
import { asSupabaseClient, createFakeSupabase } from './tests/supabase.js';
import { resolveTablesWith } from './tests/tables.js';

const tables = resolveTablesWith(['todos', { table: 'tags', primaryKey: 'tag_id' }], {
  todos: ['id', 'title'],
  tags: ['tag_id', 'name'],
});

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
    const errors: SupapowerError[] = [];

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
    expect(errors[0]?.code).toBe('connection_failed');
    // realtime-js rejoins on its own; tearing it down here would fight that.
    expect(channel?.removed).toBe(false);

    controller.abort();
    await running;
  });
});

describe('runIncomingSync - schema drift', () => {
  test('trims an unknown column off a remote change and reports it once', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();
    const controller = new AbortController();
    const errors: SupapowerError[] = [];

    const running = runIncomingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables,
      signal: controller.signal,
      onError: (error) => errors.push(error),
    });

    const drifted = { id: 1, title: 'one', added_later: 'boom' };

    supabase.openChannel?.emit(insert('todos', drifted));
    supabase.openChannel?.emit(insert('todos', { ...drifted, id: 2 }));

    expect(await waitFor(() => errors.length > 0)).toBe(true);
    await settle();

    // Drift affects every row, so one notice is the useful part.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('column_ignored');
    expect(errors[0]?.message).toContain('"added_later"');

    controller.abort();
    await running;
  });
});

describe('runIncomingSync - catching up after a dropped channel', () => {
  const start = (supabase: ReturnType<typeof createFakeSupabase>, signal: AbortSignal) =>
    runIncomingSync({
      pg: asPGlite(createFakePGlite()),
      supabase: asSupabaseClient(supabase),
      tables,
      signal,
    });

  test('downloads again when the channel comes back', async () => {
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = start(supabase, controller.signal);

    expect(await waitFor(() => supabase.calls.includes('select:tags'))).toBe(true);

    const downloads = supabase.calls.length;

    // realtime-js rejoins on its own but replays nothing, so whatever changed
    // in between has to be fetched.
    supabase.openChannel?.report('CHANNEL_ERROR');
    supabase.openChannel?.report('SUBSCRIBED');

    expect(await waitFor(() => supabase.calls.length > downloads)).toBe(true);
    expect(supabase.calls.slice(downloads)).toEqual(['select:todos', 'select:tags']);

    controller.abort();
    await running;
  });

  test('does not download twice on the first subscribe', async () => {
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = start(supabase, controller.signal);

    expect(await waitFor(() => supabase.calls.includes('select:tags'))).toBe(true);
    await settle();

    expect(supabase.calls).toEqual(['select:todos', 'select:tags']);

    controller.abort();
    await running;
  });

  test('downloads once per outage, not once per status report', async () => {
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = start(supabase, controller.signal);

    await waitFor(() => supabase.calls.includes('select:tags'));

    const downloads = supabase.calls.length;

    supabase.openChannel?.report('TIMED_OUT');
    supabase.openChannel?.report('CHANNEL_ERROR');
    supabase.openChannel?.report('SUBSCRIBED');
    supabase.openChannel?.report('SUBSCRIBED');

    expect(await waitFor(() => supabase.calls.length > downloads)).toBe(true);
    await settle();

    expect(supabase.calls).toHaveLength(downloads * 2);

    controller.abort();
    await running;
  });
});

describe('runIncomingSync - tables outside "public"', () => {
  const configured = resolveTablesWith(
    [
      { table: 'todos', schema: 'app' },
      { table: 'notes', schema: 'app', localSchema: 'mirror' },
    ],
    { 'app.todos': ['id', 'title'], 'mirror.notes': ['id', 'title'] },
  );

  test('binds the channel to the remote schema', async () => {
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = runIncomingSync({
      pg: asPGlite(createFakePGlite()),
      supabase: asSupabaseClient(supabase),
      tables: configured,
      signal: controller.signal,
    });

    // Both are "app" upstream; where they land locally is nothing realtime
    // knows about.
    expect(supabase.openChannel?.bindings).toEqual(['app.todos', 'app.notes']);

    controller.abort();
    await running;
  });

  test('applies a change to the local schema the table was mapped to', async () => {
    const pg = createFakePGlite();
    const supabase = createFakeSupabase();
    const controller = new AbortController();

    const running = runIncomingSync({
      pg: asPGlite(pg),
      supabase: asSupabaseClient(supabase),
      tables: configured,
      signal: controller.signal,
    });

    supabase.openChannel?.emit({
      ...insert('notes', { id: 1, title: 'from another device' }),
      schema: 'app',
    });

    expect(await waitFor(() => ran(pg, 'INSERT INTO "mirror"."notes"'))).toBe(true);

    controller.abort();
    await running;
  });
});
