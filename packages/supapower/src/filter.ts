import {
  postgresChangesFilter,
  type RealtimePostgresChangesFilterOperator,
  type Session,
} from '@supabase/supabase-js';

import { asSupapowerError, type SupapowerError } from './errors.js';
import type { ResolvedTableConfig } from './types.js';

export type SupapowerFilterValue = string | number | boolean | null;
export type SupapowerFilterIsValue = null | boolean | 'null' | 'true' | 'false' | 'unknown';
export type SupapowerFilterListValue = ReadonlyArray<string | number | boolean>;

/** One condition, in the form both PostgREST and Realtime take it. */
export interface ResolvedFilterCondition {
  readonly column: string;
  /** The operator token, e.g. `eq` or `in`. */
  readonly operator: string;
  /** The serialized value, e.g. `7`, `(draft,archived)`, `null`, `"a,b"`. */
  readonly value: string;
  /** Whether the condition is negated, i.e. carries Realtime's `not.` prefix. */
  readonly negate: boolean;
}

export interface ResolvedFilter {
  /** Every condition the callback added, in order. */
  readonly conditions: readonly ResolvedFilterCondition[];
  /** The conditions as a `postgres_changes` filter string, e.g. `workspace_id=eq.7,archived=is.false`. */
  readonly expression: string;
}

/** Every operator whose value is a plain scalar, i.e. all but `in` and `is`. */
type ScalarOperator = Exclude<RealtimePostgresChangesFilterOperator, 'in' | 'is'>;

/** Whatever one of the operators accepts. */
type AnyFilterValue = SupapowerFilterValue | SupapowerFilterIsValue | SupapowerFilterListValue;

/**
 * Serializes one condition through Realtime's own builder, so both ends of
 * the sync agree on the wire format - quoting of `,`, `(`, `)`, `"` and `\`
 * included.
 */
function condition(
  column: string,
  operator: RealtimePostgresChangesFilterOperator,
  value: AnyFilterValue,
  negate: boolean,
): ResolvedFilterCondition {
  // `not()` is the only method that takes the operator as a token, so every
  // condition goes through it and the known `not.` prefix is sliced off again.
  // Its overloads split `in` and `is` out by value type, but the serializer
  // behind them switches on the operator at runtime - so this one call through
  // the scalar overload serializes all three alike.
  const built = postgresChangesFilter()
    .not(column, operator as ScalarOperator, value as SupapowerFilterValue)
    .build();

  const prefix = `${column}=not.${operator}.`;

  return { column, operator, value: built.slice(prefix.length), negate };
}

/** One condition, back in the form both PostgREST and Realtime read it. */
const serialize = ({ column, operator, value, negate }: ResolvedFilterCondition): string =>
  `${column}=${negate ? 'not.' : ''}${operator}.${value}`;

/**
 * Builder handed to a table's `filter` callback, mirroring Realtime's
 * `postgresChangesFilter()` one method at a time.
 *
 * Nominal on purpose - a callback cannot return some other object shaped like
 * a filter by mistake.
 */
export class SupapowerFilter {
  readonly #conditions: ResolvedFilterCondition[] = [];

  /** Every condition added so far, in order. */
  get conditions(): readonly ResolvedFilterCondition[] {
    return this.#conditions;
  }

  #add(
    column: string,
    operator: RealtimePostgresChangesFilterOperator,
    value: AnyFilterValue,
    negate = false,
  ): this {
    this.#conditions.push(condition(column, operator, value, negate));

    return this;
  }

  /** Match rows where `column` equals `value`. */
  eq(column: string, value: SupapowerFilterValue): this {
    return this.#add(column, 'eq', value);
  }

  /** Match rows where `column` does not equal `value`. */
  neq(column: string, value: SupapowerFilterValue): this {
    return this.#add(column, 'neq', value);
  }

  /** Match rows where `column` is greater than `value`. */
  gt(column: string, value: SupapowerFilterValue): this {
    return this.#add(column, 'gt', value);
  }

  /** Match rows where `column` is greater than or equal to `value`. */
  gte(column: string, value: SupapowerFilterValue): this {
    return this.#add(column, 'gte', value);
  }

  /** Match rows where `column` is less than `value`. */
  lt(column: string, value: SupapowerFilterValue): this {
    return this.#add(column, 'lt', value);
  }

  /** Match rows where `column` is less than or equal to `value`. */
  lte(column: string, value: SupapowerFilterValue): this {
    return this.#add(column, 'lte', value);
  }

  /** Match rows where `column` is distinct from `value`. NULL-safe inequality. */
  isDistinct(column: string, value: SupapowerFilterValue): this {
    return this.#add(column, 'isdistinct', value);
  }

  /** Match rows where `column` matches the case-sensitive `pattern`. */
  like(column: string, pattern: string): this {
    return this.#add(column, 'like', pattern);
  }

  /** Match rows where `column` matches the case-insensitive `pattern`. */
  ilike(column: string, pattern: string): this {
    return this.#add(column, 'ilike', pattern);
  }

  /** Match rows where `column` matches the POSIX regex `pattern`. */
  match(column: string, pattern: string): this {
    return this.#add(column, 'match', pattern);
  }

  /** Match rows where `column` matches the case-insensitive POSIX regex `pattern`. */
  imatch(column: string, pattern: string): this {
    return this.#add(column, 'imatch', pattern);
  }

  /** Match rows where `column` is one of `values`. Requires at least one value. */
  in(column: string, values: SupapowerFilterListValue): this {
    return this.#add(column, 'in', values);
  }

  /** Match rows where `column` `IS` the given value. */
  is(column: string, value: SupapowerFilterIsValue): this {
    return this.#add(column, 'is', value);
  }

  /** Negate any operator with the `not.` prefix. */
  not(column: string, operator: 'in', value: SupapowerFilterListValue): this;
  not(column: string, operator: 'is', value: SupapowerFilterIsValue): this;
  not(column: string, operator: ScalarOperator, value: SupapowerFilterValue): this;
  not(
    column: string,
    operator: RealtimePostgresChangesFilterOperator,
    value: AnyFilterValue,
  ): this {
    return this.#add(column, operator, value, true);
  }
}

/**
 * A table's `filter` callback: handed a fresh {@link SupapowerFilter} and the
 * current session, and must return the builder.
 */
export type SupapowerFilterCallback = (
  filter: SupapowerFilter,
  session: Session | null,
) => SupapowerFilter;

/**
 * Turns a table's `filter` callback into a filter both ends of the sync can
 * use.
 *
 * Returns `null` when the table has no callback, or when the callback added
 * no condition - an empty builder means "no filter", the same as Realtime
 * treats it.
 */
export function resolveFilter(
  config: ResolvedTableConfig,
  session: Session | null,
): ResolvedFilter | null {
  if (!config.filter) {
    return null;
  }

  const { conditions } = config.filter(new SupapowerFilter(), session);

  if (conditions.length === 0) {
    return null;
  }

  return { conditions, expression: conditions.map(serialize).join(',') };
}

export interface ResolvedFilters {
  /** The filter each table resolved to, by qualified local name; a table that syncs whole is absent. */
  readonly filters: Map<string, ResolvedFilter>;
  /** Why a table's filter could not be resolved, keyed the same way. */
  readonly failed: Map<string, SupapowerError>;
}

/** Resolves every table's filter for one session; never throws. */
export function resolveFilters(
  configs: Map<string, ResolvedTableConfig>,
  session: Session | null,
): ResolvedFilters {
  const filters = new Map<string, ResolvedFilter>();
  const failed = new Map<string, SupapowerError>();

  for (const [name, config] of configs) {
    try {
      const resolved = resolveFilter(config, session);

      if (resolved !== null) {
        filters.set(name, resolved);
      }
    } catch (error: unknown) {
      failed.set(
        name,
        asSupapowerError(error, `Could not resolve the filter for ${name}`, 'filter_failed'),
      );
    }
  }

  return { filters, failed };
}

/** A PostgREST query, as far as a filter is concerned. */
interface Filterable {
  filter(column: string, operator: string, value: unknown): Filterable;
  not(column: string, operator: string, value: unknown): Filterable;
}

/** Narrows a PostgREST query to the rows a resolved filter allows. */
export function applyFilter<Query extends Filterable>(query: Query, filter: ResolvedFilter): Query {
  return filter.conditions.reduce<Filterable>(
    (narrowed, { column, operator, value, negate }) =>
      negate ? narrowed.not(column, operator, value) : narrowed.filter(column, operator, value),
    query,
  ) as Query;
}
