/**
 * Snapshot of where the local database stands relative to Supabase.
 *
 * The engine replaces the whole object on every change, so consumers can
 * compare by reference to decide whether to re-render.
 */
export interface SyncStatus {
  /** Whether the client currently holds a connection to Supabase. */
  readonly connected: boolean;
  /** Whether a full download has completed at least once. */
  readonly hasSynced: boolean;
  /** Whether local writes are being pushed upstream right now. */
  readonly uploading: boolean;
  /** Whether remote changes are being pulled down right now. */
  readonly downloading: boolean;
  /** When the last download completed, or `null` before the first one. */
  readonly lastSyncedAt: Date | null;
}

/** The status of a client that has been created but has not connected yet. */
export function createInitialSyncStatus(): SyncStatus {
  return {
    connected: false,
    hasSynced: false,
    uploading: false,
    downloading: false,
    lastSyncedAt: null,
  };
}

/** Whether the client is currently moving data in either direction. */
export function isBusy(status: SyncStatus): boolean {
  return status.uploading || status.downloading;
}
