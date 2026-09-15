/** Yields to the event loop so detached work can make progress. */
export function settle(): Promise<void> {
  return Bun.sleep(0);
}

/**
 * Polls until `done()` holds, so tests never depend on a fixed tick count.
 *
 * @returns Whether the condition was reached before giving up.
 */
export async function waitFor(done: () => boolean, attempts = 200): Promise<boolean> {
  for (let attempt = 0; attempt < attempts && !done(); attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by nature
    await settle();
  }

  return done();
}
