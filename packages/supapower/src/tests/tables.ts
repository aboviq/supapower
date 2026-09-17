import { resolveTables, withLocalColumns } from '../sync.js';
import type { SupapowerSyncedTable, SupapowerTableConfig } from '../types.js';
import { escapeIdentifier } from '../utils.js';

/**
 * Resolves a configuration and describes it against a local schema the test
 * declares.
 *
 * The columns are not incidental: an incoming row is trimmed to them, and a
 * table left out here has every change trimmed away to nothing.
 *
 * @param columns Keyed as `<schema>.<table>`, or by bare table name for the
 *   `public` tables most fixtures use. Quoting is this helper's job.
 */
export function resolveTablesWith(
  tables: Array<SupapowerTableConfig | string>,
  columns: Record<string, readonly string[]>,
): Map<string, SupapowerSyncedTable> {
  const configs = resolveTables(tables);

  return withLocalColumns(
    configs,
    new Map(
      [...configs.values()].map(({ localSchema, table }) => [
        escapeIdentifier(localSchema, table),
        columns[`${localSchema}.${table}`] ?? columns[table] ?? [],
      ]),
    ),
  );
}
