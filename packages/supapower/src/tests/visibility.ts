/** The slice of `document` that {@link createFakeDocument} stands in for. */
export interface FakeDocument {
  visibilityState: string;
  /** How many `visibilitychange` listeners are currently attached. */
  readonly listeners: number;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
  /** Flips visibility and fires the listeners, as the browser would. */
  set(state: 'visible' | 'hidden'): void;
}

/** A `document` stand-in for driving visibility-gated leadership in tests. */
export function createFakeDocument(initial: 'visible' | 'hidden' = 'visible'): FakeDocument {
  const listeners = new Set<() => void>();
  let visibilityState: string = initial;

  return {
    get visibilityState() {
      return visibilityState;
    },
    set visibilityState(value) {
      visibilityState = value;
    },
    get listeners() {
      return listeners.size;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    set(state) {
      visibilityState = state;

      for (const listener of listeners) {
        listener();
      }
    },
  };
}
