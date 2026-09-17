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
  listen(): Promise<() => Promise<void>>;
}

/** A {@link FakePGlite} that also carries `PGliteWorker`'s leader election. */
export interface FakeWorkerPGlite extends FakePGlite {
  isLeader: boolean;
  onLeaderChange(callback: () => void): () => void;
  /** Flips leadership and fires the change listeners, as the worker would. */
  setLeader(value: boolean): void;
  /** How many leader-change listeners are currently attached. */
  readonly leaderListeners: number;
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

export interface FakeWorkerPGliteOptions extends FakePGliteOptions {
  /** Whether this tab starts out as the leader. */
  isLeader?: boolean;
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
    listen: () => Promise.resolve(() => Promise.resolve()),
  };
}

/** A plain `PGlite`: no leader election, so nothing coordinates across tabs. */
export function createFakePGlite(options: FakePGliteOptions = {}): FakePGlite {
  return createBase(options);
}

/**
 * A `PGliteWorker`-like instance, down to the `isLeader` / `onLeaderChange`
 * pair that {@link isLeaderAware} looks for.
 */
export function createFakeWorkerPGlite({
  isLeader = false,
  ...options
}: FakeWorkerPGliteOptions = {}): FakeWorkerPGlite {
  const callbacks = new Set<() => void>();

  // The base has only data properties, so spreading it is safe - but the
  // leader parts must be declared here rather than assigned onto it, since
  // both a spread and `Object.assign` would read `leaderListeners` once and
  // freeze the count.
  const pg: FakeWorkerPGlite = {
    ...createBase(options),
    isLeader,
    onLeaderChange(callback: () => void) {
      callbacks.add(callback);

      return () => callbacks.delete(callback);
    },
    setLeader(value: boolean) {
      pg.isLeader = value;

      for (const callback of callbacks) {
        callback();
      }
    },
    get leaderListeners() {
      return callbacks.size;
    },
  };

  return pg;
}
