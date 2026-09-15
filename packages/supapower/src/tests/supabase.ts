import type { SupabaseClient } from '@supabase/supabase-js';

/** The shape of a PostgREST error, as far as the sync loop is concerned. */
export interface ResponseError {
  code: string;
  message: string;
}

/** Decides how the fake answers the n:th write, counting from zero. */
export type Respond = (call: number) => ResponseError | null;

export interface FakeSupabase {
  /** Every write issued, as `"<operation>:<table>"`, in order. */
  readonly calls: string[];
  from(table: string): {
    upsert(): Promise<{ error: ResponseError | null }>;
    delete(): { eq(): Promise<{ error: ResponseError | null }> };
  };
}

/** Hands the fake to code that expects the real thing. */
export function asSupabaseClient(supabase: FakeSupabase): SupabaseClient {
  return supabase as unknown as SupabaseClient;
}

/**
 * A Supabase client that records the writes it receives and answers each one
 * with whatever `respond` returns.
 *
 * @param respond Defaults to accepting everything.
 */
export function createFakeSupabase(respond: Respond = () => null): FakeSupabase {
  const calls: string[] = [];

  const record = (operation: string) => {
    calls.push(operation);

    return Promise.resolve({ error: respond(calls.length - 1) });
  };

  return {
    calls,
    from: (table: string) => ({
      upsert: () => record(`upsert:${table}`),
      delete: () => ({ eq: () => record(`delete:${table}`) }),
    }),
  };
}
