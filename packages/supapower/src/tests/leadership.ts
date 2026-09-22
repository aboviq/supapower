import { createFakeDocument, type FakeDocument } from './visibility.js';
import { createFakeLockManager, type FakeLockManager } from './web-locks.js';

export interface FakeLeadershipEnv {
  locks: FakeLockManager;
  document: FakeDocument;
  /** Puts `globalThis` back the way it was. */
  restore(): void;
}

/**
 * Installs `navigator.locks` and `document` globals so `createLeadership`
 * picks the `visible-tab` strategy, and hands back the fakes driving it.
 */
export function installLeadershipEnv(
  visibility: 'visible' | 'hidden' = 'visible',
): FakeLeadershipEnv {
  const navigator = globalThis.navigator as { locks?: FakeLockManager };
  const locks = createFakeLockManager();
  const document = createFakeDocument(visibility);

  navigator.locks = locks;
  (globalThis as { document?: FakeDocument }).document = document;

  return {
    locks,
    document,
    restore() {
      delete navigator.locks;
      delete (globalThis as { document?: FakeDocument }).document;
    },
  };
}
