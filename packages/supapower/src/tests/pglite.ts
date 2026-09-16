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
}

export interface FakeWorkerPGliteOptions extends FakePGliteOptions {
  /** Whether this tab starts out as the leader. */
  isLeader?: boolean;
}

/** Hands the fake to code that expects the real thing. */
export function asPGlite(pg: FakePGlite): PGliteInterface {
  return pg as unknown as PGliteInterface;
}

function createBase({ changes = [] }: FakePGliteOptions): FakePGlite {
  const statements: string[] = [];
  const queue = [...changes];
  const metadata = new Map<string, unknown>();
  const truncated: string[] = [];

  const sql: FakeSql = (strings, ...values) => {
    const text = strings.join('?').replaceAll(/\s+/g, ' ').trim();

    statements.push(text);

    // `ANY(?::text[])` is the reachable-table filter the outgoing sync applies.
    const reachable = (position: number) => {
      const names = values[position];

      return Array.isArray(names) ? new Set(names as string[]) : undefined;
    };

    if (text.startsWith('SELECT tx_id')) {
      const names = reachable(0);
      const oldest = queue.find((row) => !names || names.has(row.table_name));

      return Promise.resolve({ rows: oldest ? [{ tx_id: oldest.tx_id }] : [] });
    }

    if (text.startsWith('SELECT * FROM supapower.changes')) {
      const names = reachable(1);

      return Promise.resolve({
        rows: queue.filter(
          (row) => row.tx_id === values[0] && (!names || names.has(row.table_name)),
        ),
      });
    }

    if (text.startsWith('DELETE FROM supapower.changes')) {
      const names = reachable(1);

      const matches = text.includes('table_name = ?')
        ? (row: ChangeRow) => row.table_name === values[0]
        : (row: ChangeRow) => row.tx_id === values[0] && (!names || names.has(row.table_name));

      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const row = queue[index];

        if (row && matches(row)) {
          queue.splice(index, 1);
        }
      }
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
