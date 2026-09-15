import type { PGliteInterface } from '@electric-sql/pglite';

import type { ChangeRow } from '../changes.js';

interface QueryResult {
  rows: unknown[];
}

type FakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<QueryResult>;

export interface FakePGlite {
  /** Every statement issued, whitespace collapsed and parameters shown as `?`. */
  readonly statements: string[];
  /** The rows still waiting in `supapower.changes`. */
  readonly queue: ChangeRow[];
  readonly waitReady: Promise<void>;
  sql: FakeSql;
  transaction<T>(callback: (tx: { sql: FakeSql }) => Promise<T>): Promise<T>;
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

  const sql: FakeSql = (strings, ...values) => {
    const text = strings.join('?').replaceAll(/\s+/g, ' ').trim();

    statements.push(text);

    if (text.startsWith('SELECT tx_id')) {
      const [oldest] = queue;

      return Promise.resolve({ rows: oldest ? [{ tx_id: oldest.tx_id }] : [] });
    }

    if (text.startsWith('SELECT * FROM supapower.changes')) {
      return Promise.resolve({ rows: queue.filter((row) => row.tx_id === values[0]) });
    }

    if (text.startsWith('DELETE FROM supapower.changes')) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index]?.tx_id === values[0]) {
          queue.splice(index, 1);
        }
      }
    }

    return Promise.resolve({ rows: [] });
  };

  return {
    statements,
    queue,
    waitReady: Promise.resolve(),
    sql,
    transaction: (callback) => callback({ sql }),
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
