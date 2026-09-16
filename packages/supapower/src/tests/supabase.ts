import type { SupabaseClient } from '@supabase/supabase-js';

/** The shape of a PostgREST error, as far as the sync loop is concerned. */
export interface ResponseError {
  code: string;
  message: string;
}

/** Decides how the fake answers the n:th write, counting from zero. */
export type Respond = (call: number) => ResponseError | null;

type SubscribeStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

interface ChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  schema: string;
  table: string;
  commit_timestamp: string;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

export interface FakeRealtimeChannel {
  readonly name: string;
  /** Every `postgres_changes` binding, as `<schema>.<table>`, in order. */
  readonly bindings: string[];
  readonly subscribed: boolean;
  readonly removed: boolean;
  on(
    type: string,
    filter: { event: string; schema: string; table: string },
    callback: (payload: ChangePayload) => void,
  ): FakeRealtimeChannel;
  subscribe(callback?: (status: SubscribeStatus, error?: Error) => void): FakeRealtimeChannel;
  /** Delivers a change to the binding for `table`, as the server would. */
  emit(payload: ChangePayload): void;
  /** Reports a subscribe status back to whoever called `subscribe`. */
  report(status: SubscribeStatus, error?: Error): void;
}

export interface FakeSupabase {
  /** Every write issued, as `"<operation>:<table>"`, in order. */
  readonly calls: string[];
  /** The payload of every write, in the same order as the `calls` that carry one. */
  readonly payloads: Array<Record<string, unknown>>;
  /** Every `select` issued, as `"<table>:<columns>"`, in order. */
  readonly requestedColumns: string[];
  /** Every channel opened, in order, whether or not it is still open. */
  readonly channels: FakeRealtimeChannel[];
  /** The channel that is currently open, if any. */
  readonly openChannel: FakeRealtimeChannel | undefined;
  from(table: string): {
    upsert(row: Record<string, unknown>): Promise<{
      error: ResponseError | null;
      count: number | null;
    }>;
    update(
      row: Record<string, unknown>,
      options?: { count?: string },
    ): { eq(): Promise<{ error: ResponseError | null; count: number | null }> };
    delete(options?: { count?: string }): {
      eq(): Promise<{ error: ResponseError | null; count: number | null }>;
    };
    select(columns?: string): FakeSelect;
  };
  channel(name: string): FakeRealtimeChannel;
  removeChannel(channel: FakeRealtimeChannel): Promise<'ok'>;
  auth: { onAuthStateChange(callback: AuthCallback): AuthSubscription };
  /** Signs a user in or out, notifying the auth listeners. */
  setUser(userId: string | null): void;
  /** Emits `TOKEN_REFRESHED` for the current session, as auth-js does hourly. */
  refreshToken(): void;
}

interface SelectResult {
  data: Array<Record<string, unknown>>;
  error: ResponseError | null;
}

/** A thenable query builder, the shape PostgREST's own builder has. */
export interface FakeSelect extends PromiseLike<SelectResult> {
  gte(column: string, value: string): FakeSelect;
  /** Type-level on the real builder; here it just keeps the chain going. */
  returns<_T>(): FakeSelect;
}

type AuthCallback = (event: string, session: { user: { id: string } } | null) => void;
type AuthSubscription = { data: { subscription: { unsubscribe(): void } } };

export interface FakeSupabaseOptions {
  /** How the n:th write is answered. Defaults to accepting everything. */
  respond?: Respond;
  /**
   * How many rows a `delete()` or `update()` reports touching. Defaults to one.
   *
   * Zero is what row-level security refusing a write looks like: the row is
   * filtered out of the `USING` clause rather than raising.
   */
  deletedRows?: (table: string) => number | null;
  /** How many rows an `update()` reports touching. Defaults to `deletedRows`. */
  updatedRows?: (table: string) => number | null;
  /** What `select()` returns per table. Defaults to an empty table. */
  rows?: Record<string, Array<Record<string, unknown>>>;
  /** Fails `select()` for the tables it answers for. */
  downloadError?: (table: string) => ResponseError | null;
  /** Who is signed in to begin with. */
  user?: string | null;
  /**
   * `false` replaces `auth` with the proxy that throws on every access, which
   * is what supabase-js installs for a client built with `accessToken`.
   */
  auth?: boolean;
}

/** Hands the fake to code that expects the real thing. */
export function asSupabaseClient(supabase: FakeSupabase): SupabaseClient {
  return supabase as unknown as SupabaseClient;
}

const ignoreStatus = (_status: SubscribeStatus, _error?: Error): void => {};

/**
 * Records the query only once it is awaited, so a `.gte()` added after
 * `select()` still shows up in `calls`.
 */
function createSelect(
  table: string,
  rows: Array<Record<string, unknown>>,
  downloadError: (table: string) => ResponseError | null,
  calls: string[],
  requested: string,
  requestedColumns: string[],
): FakeSelect {
  let filter: string | undefined;
  let from: string | undefined;

  const select: FakeSelect = {
    gte(column, value) {
      filter = column;
      from = value;

      return select;
    },
    returns() {
      return select;
    },
    // PostgREST's query builder is itself thenable, which is what this stands in for.
    // oxlint-disable-next-line unicorn/no-thenable
    then(onResolved, onRejected) {
      const column = filter;
      const lowest = from;

      const filtered = column === undefined ? '' : `:gte(${column})`;

      calls.push(`select:${table}${filtered}`);
      requestedColumns.push(`${table}:${requested}`);

      const error = downloadError(table);

      const matching =
        column === undefined || lowest === undefined
          ? rows
          : rows.filter((row) => {
              const value = row[column];

              return typeof value === 'string' && value >= lowest;
            });

      return Promise.resolve({ data: error ? [] : matching, error }).then(onResolved, onRejected);
    },
  };

  return select;
}

function createChannel(name: string): FakeRealtimeChannel {
  const handlers = new Map<string, (payload: ChangePayload) => void>();
  const bindings: string[] = [];
  let report: (status: SubscribeStatus, error?: Error) => void = ignoreStatus;

  const channel: FakeRealtimeChannel = {
    name,
    bindings,
    subscribed: false,
    removed: false,
    on(_type, filter, callback) {
      bindings.push(`${filter.schema}.${filter.table}`);
      handlers.set(filter.table, callback);

      return channel;
    },
    subscribe(callback) {
      (channel as { subscribed: boolean }).subscribed = true;

      if (callback) {
        report = callback;
        callback('SUBSCRIBED');
      }

      return channel;
    },
    emit(payload) {
      handlers.get(payload.table)?.(payload);
    },
    report: (status, error) => report(status, error),
  };

  return channel;
}

/**
 * A Supabase client that records the writes it receives, hands out driveable
 * realtime channels, and lets a test move the signed in user around.
 *
 * @param options Defaults to accepting every write with nobody signed in.
 */
export function createFakeSupabase({
  respond = () => null,
  deletedRows = () => 1,
  updatedRows,
  rows = {},
  downloadError = () => null,
  user = null,
  auth = true,
}: FakeSupabaseOptions = {}): FakeSupabase {
  const calls: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const requestedColumns: string[] = [];
  const channels: FakeRealtimeChannel[] = [];
  const listeners = new Set<AuthCallback>();
  let currentUser = user;

  const record = (
    operation: string,
    count: number | null,
    payload: Record<string, unknown> = {},
  ) => {
    calls.push(operation);
    payloads.push(payload);

    return Promise.resolve({ error: respond(calls.length - 1), count });
  };

  const session = () => (currentUser === null ? null : { user: { id: currentUser } });

  const authApi = {
    onAuthStateChange(callback: AuthCallback) {
      listeners.add(callback);

      // The real client emits INITIAL_SESSION once its own init settles, so
      // never in the same tick as the call that registered the listener.
      queueMicrotask(() => {
        if (listeners.has(callback)) {
          callback('INITIAL_SESSION', session());
        }
      });

      return {
        data: { subscription: { unsubscribe: () => listeners.delete(callback) } },
      };
    },
  };

  const throwingAuth = new Proxy(
    {},
    {
      get() {
        throw new Error(
          '@supabase/supabase-js: Supabase Client is configured with the accessToken option, accessing supabase.auth is not possible',
        );
      },
    },
  ) as FakeSupabase['auth'];

  const supabase: FakeSupabase = {
    calls,
    payloads,
    requestedColumns,
    channels,
    get openChannel() {
      return channels.findLast((channel) => !channel.removed);
    },
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>) => record(`upsert:${table}`, null, row),
      update: (row: Record<string, unknown>) => ({
        eq: () => record(`update:${table}`, (updatedRows ?? deletedRows)(table), row),
      }),
      delete: () => ({ eq: () => record(`delete:${table}`, deletedRows(table)) }),
      select: (requested = '*') =>
        createSelect(table, rows[table] ?? [], downloadError, calls, requested, requestedColumns),
    }),
    channel(name) {
      const created = createChannel(name);

      channels.push(created);

      return created;
    },
    removeChannel(channel) {
      (channel as { removed: boolean }).removed = true;

      return Promise.resolve('ok');
    },
    auth: auth ? authApi : throwingAuth,
    setUser(userId) {
      currentUser = userId;

      for (const listener of listeners) {
        listener(userId === null ? 'SIGNED_OUT' : 'SIGNED_IN', session());
      }
    },
    refreshToken() {
      for (const listener of listeners) {
        listener('TOKEN_REFRESHED', session());
      }
    },
  };

  return supabase;
}
