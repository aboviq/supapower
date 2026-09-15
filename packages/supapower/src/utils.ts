import type { PGliteInterface, Transaction } from '@electric-sql/pglite';

// oxlint-disable-next-line typescript/no-explicit-any
export const once = <T extends (...args: any[]) => any>(fn: T): T => {
  let called = false;
  let result: ReturnType<T>;
  return ((...args: Parameters<T>) => {
    if (!called) {
      called = true;
      result = fn(...args);
    }
    return result;
  }) as T;
};

/**
 * Utility function to execute a handler within a transaction.
 *
 * If a PGlite instance is provided, it will start a new transaction.
 * If a Transaction is provided, it will use the existing transaction.
 *
 * @param pg A PGlite instance or a Transaction
 * @param handler The function to execute within the transaction
 * @returns The result of the handler function
 */
export const executeInTransaction = async <T>(
  pg: PGliteInterface | Transaction,
  handler: (tx: Transaction) => Promise<T>,
): Promise<T> => {
  if ('transaction' in pg) {
    return pg.transaction((tx) => handler(tx));
  }

  return handler(pg);
};

/**
 * Utility function to escape SQL identifiers by wrapping them in double quotes and escaping any existing double quotes within the identifier.
 *
 * @example
 * ```ts
 * escapeIdentifier('schema', 'table'); // => '"schema"."table"'
 * ```
 *
 * @param parts The parts of the identifier to escape
 * @returns The escaped identifier as a string
 */
export function escapeIdentifier(...parts: string[]): string {
  return parts.map((part) => `"${part.replaceAll('"', '""')}"`).join('.');
}
