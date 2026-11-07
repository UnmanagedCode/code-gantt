import path from 'node:path';
import { loadSessions } from './store/sessions.js';
import { EventLogReader } from './store/events.js';
import { createSerializer } from './serial.js';

/** Holds the readers and the snapshot the payload is built from. No payload logic lives here. */
export function createState(config) {
  const serialize = createSerializer();
  const state = {
    config,
    sessions: null,
    events: new EventLogReader(path.join(config.storeDir, 'events.jsonl')),
    liveSet: null, // Set of live public ids, or null when liveness is unavailable
    version: 0,
    onVersion: null,
    bump() {
      state.version++;
      state.onVersion?.(state.version);
    },
    refreshStores() {
      return serialize(async () => {
        state.sessions = await loadSessions(config.storeDir, state.sessions);
        await state.events.refresh();
      });
    },
  };
  return state;
}
