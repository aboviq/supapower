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
