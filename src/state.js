import path from 'node:path';
import { loadSessions } from './store/sessions.js';
import { EventLogReader } from './store/events.js';
import { CostsReader } from './store/costs.js';
import { BackfillIndex } from './backfill/index.js';
import { createDataDir } from './dataDir.js';
import { createSerializer } from './serial.js';

const VERSION_EVERY_N_FILES = 25;

/** Holds the readers and the snapshot the payload is built from. No payload logic lives here. */
export function createState(config) {
  const dataDir = createDataDir(config.dataDir);
  dataDir.ensure();
  const serialize = createSerializer();
  const state = {
    config,
    sessions: null,
    events: new EventLogReader(path.join(config.storeDir, 'events.jsonl')),
    costs: new CostsReader(path.join(config.storeDir, 'costs.jsonl')),
    backfill: new BackfillIndex({ transcriptRoot: config.transcriptRoot, dataDir }),
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
        await state.costs.refresh();
      });
    },
    /** Background backfill; bumps the version every few files and at the end. */
    async runBackfill() {
      let last = 0;
      await state.backfill.scan(state.sessions.byId, {
        onProgress: (p) => {
          if (p.state === 'ready' || p.filesDone - last >= VERSION_EVERY_N_FILES) {
            last = p.filesDone;
            state.bump();
          }
        },
      });
    },
  };
  return state;
}
