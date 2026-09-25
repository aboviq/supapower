import type { Session } from '@supabase/supabase-js';

import { resolveFilters } from '../filter.js';
import { resolveTables, tablesForSession, withLocalColumns } from '../sync.js';
import type { SupapowerScopedTable, SupapowerTableConfig } from '../types.js';
import { escapeIdentifier } from '../utils.js';

/**
 * Resolves a configuration, describes it against a local schema the test
 * declares, and scopes it to a session.
 *
 * The columns are not incidental: an incoming row is trimmed to them, and a
 * table left out here has every change trimmed away to nothing.
 *
 * @param columns Keyed as `<schema>.<table>`, or by bare table name for the
 *   `public` tables most fixtures use. Quoting is this helper's job.
 * @param session Handed to each table's `filter` callback. Defaults to
 *   nobody signed in.
 */
export function resolveTablesWith(
  tables: Array<SupapowerTableConfig | string>,
  columns: Record<string, readonly string[]>,
  session: Session | null = null,
): Map<string, SupapowerScopedTable> {
  const configs = resolveTables(tables);
  const resolved = resolveFilters(configs, session);

  const [firstFailure] = resolved.failed.values();

  if (firstFailure) {
    throw firstFailure;
  }

  const described = withLocalColumns(
    configs,
    new Map(
      [...configs.values()].map(({ localSchema, table }) => [
        escapeIdentifier(localSchema, table),
        columns[`${localSchema}.${table}`] ?? columns[table] ?? [],
      ]),
    ),
  );

  // Signed in, so `access` never hides a fixture's table; a test that wants
  // an unreachable one asks `tablesForSession` itself.
  return tablesForSession(described, resolved, true).syncing;
}
