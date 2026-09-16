import { type ResolvedTableConfig, resolveTables, tableNames } from '../sync.js';
import type { SupapowerTableConfig } from '../types.js';

/**
 * Resolves a configuration against a local schema the test declares.
 *
 * The columns are not incidental: an incoming row is trimmed to them, and a
 * table left out here has every change trimmed away to nothing.
 */
export function resolveTablesWith(
  tables: Array<SupapowerTableConfig | string>,
  columns: Record<string, readonly string[]>,
): Map<string, ResolvedTableConfig> {
  return resolveTables(
    tables,
    new Map(tableNames(tables).map((table) => [table, columns[table] ?? []])),
  );
}
