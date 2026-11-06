import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const POLL_MS = 5000;
const DEBOUNCE_MS = 500;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const DEAD_STATUSES = new Set(['exited', 'crashed']);

const defaultSchedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

function defaultConnect(url, { onOpen, onMessage, onClose }) {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => onOpen());
  ws.addEventListener('message', (e) => onMessage(typeof e.data === 'string' ? e.data : ''));
  ws.addEventListener('close', () => onClose());
  ws.addEventListener('error', () => {}); // a close always follows
  return { close: () => ws.close() };
}

async function statSig(files) {
  const parts = [];
  for (const f of files) {
    try {
      const st = await fs.stat(f);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push('missing');
    }
  }
  return parts.join('|');
}

/**
 * Keeps the state fresh: polls store-file stats, listens (read-only) to cc's /ws `instances` hint,
 * and fetches liveness from GET /api/instances. Network, timers and the clock are injectable.
 * The ws client never sends frames.
 */
export function createLive({ state, config, fetch: fetchImpl = globalThis.fetch, connect = defaultConnect, schedule = defaultSchedule }) {
  const events = new EventEmitter();
  state.onVersion = (v) => events.emit('changed', v);
  const storeFiles = ['sessions.json', 'playbook-ledger.jsonl', 'costs.jsonl'].map((f) => path.join(config.storeDir, f));
  let lastSig = null;
  let stopped = false;
  let cancelPoll = null;
  let cancelDebounce = null;
  let cancelReconnect = null;
  let socket = null;
  let backoff = BACKOFF_START_MS;
  let loggedNoLiveness = false;
  let loggedFetchFail = false;
  let polling = null;

  async function refreshLiveness() {
    if (!config.conductorUrl) {
      if (!loggedNoLiveness) console.warn('[code-gantt] CONDUCTOR_URL not set: liveness unavailable, no bar is open-ended');
      loggedNoLiveness = true;
      state.liveSet = null;
      return;
    }
    try {
      const res = await fetchImpl(`${config.conductorUrl.replace(/\/$/, '')}/api/instances`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      state.liveSet = new Set(rows.filter((r) => r && typeof r.sessionId === 'string' && !DEAD_STATUSES.has(r.status)).map((r) => r.sessionId));
      loggedFetchFail = false;
    } catch (err) {
      if (!loggedFetchFail) console.warn(`[code-gantt] liveness unavailable: ${err.message}`);
      loggedFetchFail = true;
      state.liveSet = null;
    }
  }

  /** Backfill files of live owners whose size moved since the last scan. */
  function backfillStale() {
    return Promise.all(Object.entries(state.backfill.files)
      .filter(([, st]) => state.liveSet?.has(st.owner))
      .map(async ([file, st]) => {
        try {
          return (await fs.stat(file)).size !== st.size;
        } catch {
          return false;
        }
      })).then((flags) => flags.some(Boolean));
  }

  // One poll at a time. A call made mid-poll waits for the current run, and a follow-up run is
  // queued so a change that landed meanwhile is not lost.
  let inflight = null;
  let again = false;
  function poll() {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        again = false;
        await pollOnce();
      } while (again);
    })().finally(() => { inflight = null; });
    return inflight;
  }

  async function pollOnce() {
    const sig = await statSig(storeFiles);
    const storeChanged = sig !== lastSig;
    lastSig = sig;
    const transcriptsChanged = !storeChanged && (await backfillStale());
    if (!storeChanged && !transcriptsChanged) return;
    if (storeChanged) await state.refreshStores();
    await state.backfill.scan(state.sessions.byId);
    state.bump();
  }

  function tick() {
    if (stopped) return;
    polling = poll()
      .catch((err) => console.error('[code-gantt] poll failed:', err))
      .finally(() => { if (!stopped) cancelPoll = schedule(tick, POLL_MS); });
  }

  function openSocket() {
    if (stopped || !config.conductorUrl) return;
    const url = `${config.conductorUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`;
    socket = connect(url, {
      onOpen: () => { backoff = BACKOFF_START_MS; },
      onMessage: (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg?.t !== 'instances') return;
        cancelDebounce?.();
        cancelDebounce = schedule(async () => {
          await refreshLiveness();
          await poll().catch((err) => console.error('[code-gantt] poll failed:', err));
          state.bump();
        }, DEBOUNCE_MS);
      },
      onClose: () => {
        if (stopped) return;
        const delay = backoff;
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        cancelReconnect = schedule(openSocket, delay);
      },
    });
  }

  return {
    events,
    poll,
    refreshLiveness,
    async start() {
      lastSig = await statSig(storeFiles);
      await refreshLiveness();
      openSocket();
      cancelPoll = schedule(tick, POLL_MS);
    },
    stop() {
      stopped = true;
      cancelPoll?.();
      cancelDebounce?.();
      cancelReconnect?.();
      socket?.close();
      return polling;
    },
  };
}
