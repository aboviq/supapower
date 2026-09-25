import { describe, expect, test } from 'bun:test';

import { applyFilter, resolveFilter, resolveFilters } from './filter.js';
import { resolveTables } from './sync.js';
import type { ResolvedTableConfig, SupapowerTableConfig } from './types.js';

/** Resolves a single table config, for tests that only need one. */
const config = (entry: SupapowerTableConfig | string): ResolvedTableConfig =>
  [...resolveTables([entry]).values()][0]!;

describe('resolveFilter', () => {
  test('serializes conditions in order, negated ones included', () => {
    const table = config({
      table: 'todos',
      filter: (f) => f.eq('workspace_id', 7).not('status', 'in', ['draft', 'archived']),
    });

    const resolved = resolveFilter(table, null);

    expect(resolved?.expression).toBe('workspace_id=eq.7,status=not.in.(draft,archived)');
    expect(resolved?.conditions).toEqual([
      { column: 'workspace_id', operator: 'eq', value: '7', negate: false },
      { column: 'status', operator: 'in', value: '(draft,archived)', negate: true },
    ]);
  });

  test('quotes a value that would otherwise break the wire format', () => {
    const table = config({ table: 'todos', filter: (f) => f.eq('title', 'a,b') });

    expect(resolveFilter(table, null)?.expression).toBe('title=eq."a,b"');
  });

  test('serializes an `is` condition with the null keyword', () => {
    const table = config({ table: 'todos', filter: (f) => f.is('deleted_at', null) });

    expect(resolveFilter(table, null)?.expression).toBe('deleted_at=is.null');
  });

  test('resolves to null when the callback adds no condition', () => {
    const table = config({ table: 'todos', filter: (f) => f });

    expect(resolveFilter(table, null)).toBeNull();
  });

  test('resolves to null when the table has no callback at all', () => {
    expect(resolveFilter(config('todos'), null)).toBeNull();
  });
});

describe('applyFilter', () => {
  test('routes an un-negated condition through `filter`', () => {
    const calls: Array<[string, string, unknown]> = [];
    const stub = {
      filter(column: string, operator: string, value: unknown) {
        calls.push([column, operator, value]);

        return stub;
      },
      not: () => stub,
    };

    const table = config({
      table: 'todos',
      filter: (f) => f.eq('workspace_id', 7).in('status', ['draft', 'archived']),
    });

    applyFilter(stub, resolveFilter(table, null)!);

    expect(calls).toEqual([
      ['workspace_id', 'eq', '7'],
      ['status', 'in', '(draft,archived)'],
    ]);
  });

  test('routes a `not`-composed condition through `not`', () => {
    const calls: Array<[string, string, unknown]> = [];
    const stub = {
      filter: () => stub,
      not(column: string, operator: string, value: unknown) {
        calls.push([column, operator, value]);

        return stub;
      },
    };

    const table = config({
      table: 'todos',
      filter: (f) => f.not('status', 'in', ['draft', 'archived']),
    });

    applyFilter(stub, resolveFilter(table, null)!);

    expect(calls).toEqual([['status', 'in', '(draft,archived)']]);
  });
});

describe('resolveFilters', () => {
  test('reports a throwing callback as filter_failed, keyed by the local name', () => {
    const configs = resolveTables([{ table: 'todos', filter: (f) => f.in('workspace_id', []) }]);

    const { filters, failed } = resolveFilters(configs, null);

    expect(filters.size).toBe(0);
    expect(failed.get('"public"."todos"')?.code).toBe('filter_failed');
  });

  test('resolves every table that does not throw, leaves the rest out', () => {
    const configs = resolveTables([
      { table: 'todos', filter: (f) => f.eq('workspace_id', 7) },
      'projects',
    ]);

    const { filters, failed } = resolveFilters(configs, null);

    expect(failed.size).toBe(0);
    expect(filters.get('"public"."todos"')?.expression).toBe('workspace_id=eq.7');
    expect(filters.has('"public"."projects"')).toBe(false);
  });
});
