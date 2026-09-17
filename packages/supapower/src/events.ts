import type { SupapowerError } from './errors.js';
import type { SupapowerSyncedTable } from './types.js';

/**
 * A `downloadTableStart`/`downloadTableFinish` event, containing the table config it is for.
 */
export class SupapowerTableEvent extends Event {
  readonly config: SupapowerSyncedTable;

  constructor(type: 'downloadTableStart' | 'downloadTableFinish', config: SupapowerSyncedTable) {
    super(type);
    this.config = config;
  }
}

/**
 * An `error` event, carrying the {@link SupapowerError} it reports.
 *
 * Replaces the old `onError` callback: anything that went wrong but did not
 * stop the sync - a failed upload or download that will be retried, a
 * realtime channel reporting trouble, a change that could not be applied
 * locally, and a `DELETE` that matched no row upstream.
 */
export class SupapowerErrorEvent extends Event {
  readonly error: SupapowerError;

  constructor(error: SupapowerError) {
    super('error');
    this.error = error;
  }
}

/** Every event {@link SupapowerNamespace.events} dispatches. */
export interface SupapowerEventMap {
  /** The initial (or catch-up) download of every table has started. */
  downloadStart: Event;
  /** The initial (or catch-up) download of every table has finished. */
  downloadFinish: Event;
  /** A single table's download has started. */
  downloadTableStart: SupapowerTableEvent;
  /** A single table's download has finished. */
  downloadTableFinish: SupapowerTableEvent;
  /** A batch of local changes has started uploading to Supabase. */
  uploadStart: Event;
  /** A batch of local changes has finished uploading to Supabase. */
  uploadFinish: Event;
  /**
   * The realtime channel is subscribed and delivering changes.
   *
   * Only dispatched on the tab that holds leadership, and only once per
   * connection: a channel that reports trouble and rejoins on its own does
   * not get a second `connect` until `disconnect` has fired in between.
   */
  connect: Event;
  /**
   * The realtime channel stopped delivering changes - dropped, timed out, or
   * torn down because leadership was lost, the user changed, or the sync was
   * unsubscribed.
   */
  disconnect: Event;
  /** Something went wrong that did not stop the sync. */
  error: SupapowerErrorEvent;
}

/** An `EventTarget` typed for {@link SupapowerEventMap}. */
export interface SupapowerEventTarget extends EventTarget {
  addEventListener<K extends keyof SupapowerEventMap>(
    type: K,
    listener: (event: SupapowerEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof SupapowerEventMap>(
    type: K,
    listener: (event: SupapowerEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  dispatchEvent(event: SupapowerEventMap[keyof SupapowerEventMap]): boolean;
}

/**
 * Builds the `EventTarget` exposed as `pg.supapower.events`.
 *
 * A plain `EventTarget`'s `addEventListener` takes a bare `Event`; the cast
 * narrows it to {@link SupapowerEventMap}, which every event Supapower itself
 * dispatches satisfies.
 */
export function createSupapowerEvents(): SupapowerEventTarget {
  return new EventTarget() as unknown as SupapowerEventTarget;
}
