import type { SupapowerErrorCode } from './errors.js';
import type { SupapowerEventTarget } from './events.js';
import type { SupapowerStatus } from './types.js';

/** What the status looks like before anything has happened. */
const INITIAL: SupapowerStatus = Object.freeze({
  leading: false,
  connected: false,
  connecting: false,
  downloading: false,
  uploading: false,
  hasSynced: false,
  lastSyncedAt: undefined,
  downloadError: undefined,
  uploadError: undefined,
});

/**
 * Which half of the sync an `error` event belongs to.
 *
 * The codes left out - `column_ignored`, `update_ignored`, `delete_ignored` - are
 * advisory: nothing failed that a retry or the next download would fix, so they
 * stay out of the status and are only reported through the `error` event.
 */
const ERROR_SIDE: Partial<Record<SupapowerErrorCode, 'download' | 'upload'>> = {
  apply_failed: 'download',
  connection_failed: 'download',
  download_failed: 'download',
  schema_mismatch: 'upload',
  upload_failed: 'upload',
};

export interface SupapowerStatusTracker {
  /** The current snapshot. A new object every time something changed. */
  readonly current: SupapowerStatus;
  /** `sync()` was called. */
  syncing(): void;
  /** The sync was unsubscribed. */
  stopped(): void;
  /** Leadership was acquired or lost. */
  leading(value: boolean): void;
}

/**
 * Keeps a snapshot of what the sync is doing, updated from the events.
 *
 * Attached when the namespace is built, before any application listener, so a
 * listener reading `pg.supapower.status` from inside an event handler sees the
 * value that event produced.
 */
export function trackStatus(events: SupapowerEventTarget): SupapowerStatusTracker {
  let current = INITIAL;
  let syncing = false;

  const update = (patch: Partial<SupapowerStatus>): void => {
    const next = { ...current, ...patch };

    current = Object.freeze({
      ...next,
      connecting: syncing && next.leading && !next.connected,
    });

    events.dispatchEvent(new Event('statusChange'));
  };

  events.addEventListener('downloadStart', () => update({ downloading: true }));
  events.addEventListener('downloadFinish', () =>
    update({
      downloading: false,
      hasSynced: true,
      lastSyncedAt: new Date(),
      downloadError: undefined,
    }),
  );
  events.addEventListener('uploadStart', () => update({ uploading: true }));
  events.addEventListener('uploadFinish', () =>
    update({ uploading: false, uploadError: undefined }),
  );
  events.addEventListener('connect', () => update({ connected: true }));
  events.addEventListener('disconnect', () => update({ connected: false }));
  events.addEventListener('error', ({ error }) => {
    // A download or upload that failed never gets its `finish` event, so the
    // in-flight flag has to be cleared here.
    switch (ERROR_SIDE[error.code]) {
      case 'download':
        update({ downloading: false, downloadError: error });
        break;
      case 'upload':
        update({ uploading: false, uploadError: error });
        break;
      default:
        break;
    }
  });

  return {
    get current() {
      return current;
    },
    syncing() {
      syncing = true;
      update({});
    },
    stopped() {
      syncing = false;
      update({ leading: false, connected: false, downloading: false, uploading: false });
    },
    leading(value) {
      update({ leading: value });
    },
  };
}
