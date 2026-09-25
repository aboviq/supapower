import type { PGliteInterface } from '@electric-sql/pglite';

import type { ChangeRow } from '../changes.js';

interface QueryResult {
  rows: unknown[];
}

type FakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<QueryResult>;
type FakeQuery = (query: string, params?: unknown[]) => Promise<QueryResult>;

export interface FakePGlite {
  /** Every statement issued, whitespace collapsed and parameters shown as `?`. */
  readonly statements: string[];
  /** The rows still waiting in `supapower.changes`. */
  readonly queue: ChangeRow[];
  /** `supapower.metadata`, so watermarks and the synced user round-trip. */
  readonly metadata: Map<string, unknown>;
  /** Tables that have been `TRUNCATE`d, in order. */
  readonly truncated: string[];
  readonly waitReady: Promise<void>;
  sql: FakeSql;
  query: FakeQuery;
  transaction<T>(callback: (tx: { sql: FakeSql; query: FakeQuery }) => Promise<T>): Promise<T>;
  listen(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>;
  /** Fires every listener registered for `channel`, the way `pg_notify` would. */
  notify(channel: string, payload?: string): void;
}

export interface FakePGliteOptions {
  /** Rows to seed the outgoing queue with. */
  changes?: ChangeRow[];
  /**
   * The columns each table has locally, keyed by qualified name or by bare
   * table name.
   *
   * A table left out has just `"id"`, which is what the primary key check
   * needs and what most fixtures use.
   */
  columns?: Record<string, readonly string[]>;
}

/** Hands the fake to code that expects the real thing. */
export function asPGlite(pg: FakePGlite): PGliteInterface {
  return pg as unknown as PGliteInterface;
}

/** What `raw` and `identifier` produce: a fragment, not a parameter. */
function isTemplatePart(value: unknown): value is { str: string } {
  // oxlint-disable-next-line no-underscore-dangle -- PGlite's own field name.
  return typeof value === 'object' && value !== null && 'str' in value && '_templateType' in value;
}

/** Whether a queued change is for one of the reachable tables. */
const within = (names: Set<string> | undefined) => (row: ChangeRow) =>
  !names || names.has(`${row.schema_name}.${row.table_name}`);

function createBase({ changes = [], columns }: FakePGliteOptions): FakePGlite {
  const statements: string[] = [];
  const queue = [...changes];
  const metadata = new Map<string, unknown>();
  const truncated: string[] = [];
  const listeners = new Map<string, Set<(payload: string) => void>>();

  const notify = (channel: string, payload = ''): void => {
    for (const callback of listeners.get(channel) ?? []) {
      callback(payload);
    }
  };

  const sql: FakeSql = (strings, ...args) => {
    // `raw` and `identifier` template parts are substituted into the query
    // rather than parameterized, the same as PGlite's own `sql` does - so a
    // statement's schema is visible in `statements` instead of being a `?`.
    const values: unknown[] = [];

    let rendered = strings[0] ?? '';

    for (const [index, value] of args.entries()) {
      if (isTemplatePart(value)) {
        rendered += value.str;
      } else {
        rendered += '?';
        values.push(value);
      }

      rendered += strings[index + 1] ?? '';
    }

    const text = rendered.replaceAll(/\s+/g, ' ').trim();

    statements.push(text);

    // `(schema_name, table_name) IN unnest(?, ?)` is the reachable-table filter
    // the outgoing sync applies, as two parallel arrays.
    const reachable = (at: number) => {
      const schemas = values[at];
      const names = values[at + 1];

      if (!Array.isArray(schemas) || !Array.isArray(names)) {
        return undefined;
      }

      return new Set((names as string[]).map((table, index) => `${schemas[index]}.${table}`));
    };

    if (text.startsWith('SELECT tx_id')) {
      const oldest = queue.find(within(reachable(0)));

      return Promise.resolve({ rows: oldest ? [{ tx_id: oldest.tx_id }] : [] });
    }

    if (text.startsWith('SELECT * FROM supapower.changes')) {
      const matches = within(reachable(1));

      return Promise.resolve({
        rows: queue.filter((row) => row.tx_id === values[0] && matches(row)),
      });
    }

    if (text.startsWith('DELETE FROM supapower.changes')) {
      const reached = within(reachable(1));

      // Either the whole batch, or everything a truncated table had queued.
      const matches = text.includes('schema_name = ? AND table_name = ?')
        ? (row: ChangeRow) => row.schema_name === values[0] && row.table_name === values[1]
        : (row: ChangeRow) => row.tx_id === values[0] && reached(row);

      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const row = queue[index];

        if (row && matches(row)) {
          queue.splice(index, 1);
        }
      }
    }

    if (text.startsWith('SELECT table_schema, table_name, column_name FROM information_schema')) {
      const schemas = (values[0] as string[]) ?? [];
      const names = (values[1] as string[]) ?? [];

      return Promise.resolve({
        rows: names.flatMap((table, index) => {
          const schema = schemas[index] ?? 'public';

          return (columns?.[`${schema}.${table}`] ?? columns?.[table] ?? ['id'])
            .toSorted()
            .map((column) => ({ table_schema: schema, table_name: table, column_name: column }));
        }),
      });
    }

    if (text.startsWith('SELECT value FROM supapower.metadata')) {
      const key = String(values[0]);

      return Promise.resolve({
        rows: metadata.has(key) ? [{ value: metadata.get(key) }] : [],
      });
    }

    if (text.startsWith('SELECT value ->>')) {
      const table = String(values[0]);
      const key = String(values[1]);

      if (!metadata.has(key)) {
        return Promise.resolve({ rows: [] });
      }

      const value = metadata.get(key) as Record<string, string>;

      return Promise.resolve({ rows: [{ token: value[table] ?? null }] });
    }

    if (text.startsWith('INSERT INTO supapower.metadata')) {
      const key = String(values[0]);
      const value: unknown = JSON.parse(String(values[1]));

      // The real statement either merges the object in or replaces it outright.
      if (text.includes('metadata.value || EXCLUDED.value')) {
        metadata.set(key, { ...(metadata.get(key) as object), ...(value as object) });
      } else {
        metadata.set(key, value);
      }
    }

    if (text.startsWith('UPDATE supapower.metadata')) {
      const key = String(values[1]);
      const dropped = new Set(values[0] as string[]);
      const current = { ...(metadata.get(key) as Record<string, unknown>) };

      for (const name of dropped) {
        delete current[name];
      }

      metadata.set(key, current);
    }

    // The channel is a `raw` fragment, inline in the text rather than a
    // parameter - the same as the real statement `redownload()` issues.
    const notified = /^SELECT pg_notify\('([^']+)'/.exec(text);

    if (notified?.[1]) {
      notify(notified[1]);
    }

    return Promise.resolve({ rows: [] });
  };

  const query: FakeQuery = (text) => {
    const statement = text.replaceAll(/\s+/g, ' ').trim();

    statements.push(statement);

    const truncating = /^TRUNCATE TABLE "[^"]+"\."([^"]+)"/.exec(statement);

    if (truncating?.[1]) {
      truncated.push(truncating[1]);
    }

    return Promise.resolve({ rows: [] });
  };

  return {
    statements,
    queue,
    metadata,
    truncated,
    waitReady: Promise.resolve(),
    sql,
    query,
    transaction: (callback) => callback({ sql, query }),
    listen: (channel, callback) => {
      const set = listeners.get(channel) ?? new Set();

      listeners.set(channel, set);
      set.add(callback);

      return Promise.resolve(() => {
        set.delete(callback);

        return Promise.resolve();
      });
    },
    notify,
  };
}

/** A `PGlite`-like instance, with no coordination across tabs of its own. */
export function createFakePGlite(options: FakePGliteOptions = {}): FakePGlite {
  return createBase(options);
}
