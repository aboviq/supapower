/**
 * A row in the `messages` table.
 *
 * `created_at` is a `Date`: PGlite parses `timestamptz` columns into `Date`
 * objects on every read, whether the row was typed locally or synced in from
 * Supabase and written into the same local column.
 */
export interface Message {
  id: string;
  user_id: string;
  user_name: string;
  message: string;
  created_at: Date;
}

/**
 * The only table this demo needs. Run against the local PGlite database on
 * every start, before `supapower.sync()` - see the README for the matching
 * Supabase migration, which also needs Row Level Security policies and a
 * realtime publication entry that the local copy does not.
 */
export const MESSAGES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS messages (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    user_name text NOT NULL,
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`;
