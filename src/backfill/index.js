import { readFrom } from '../jsonlTail.js';
import { buildBackingIndex } from './locate.js';
import { extractLine } from './extract.js';

const CACHE = 'backfill.json';
const LEGACY_CACHE = 'backfill-v1.json'; // version 1 lacked the result time; it is never read again
const VERSION = 2;
const PERSIST_EVERY = 10;
const PREFILTER = ['mcp__code-conductor__', '[[cc:wake-callback]]', '"tool_result"'];
const prefilter = (line) => PREFILTER.some((p) => line.includes(p));

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => Number.isFinite(v) && v >= 0;
const str = (v) => typeof v === 'string';

function validCall(c) {
  return isObj(c) && str(c.id) && Number.isFinite(c.ts) && str(c.tool) && str(c.target) && typeof c.ok === 'boolean' && (c.forward === undefined || str(c.forward)) && (c.rts === undefined || Number.isFinite(c.rts));
}
function validPending(c) {
  return isObj(c) && Number.isFinite(c.ts) && str(c.tool) && str(c.target) && (c.forward === undefined || str(c.forward));
}
function validWake(w) {
  return isObj(w) && str(w.key) && Number.isFinite(w.ts) && str(w.worker) && (w.heartbeat === undefined || typeof w.heartbeat === 'boolean');
}

/** The cache is untrusted input: any shape mismatch rejects it whole (a rebuild is cheap). */
export function validCache(doc) {
  if (!isObj(doc) || doc.version !== VERSION || !isObj(doc.files)) return false;
  return Object.values(doc.files).every((f) => isObj(f) && num(f.size) && num(f.offset) && str(f.owner)
    && (f.dropped === undefined || num(f.dropped)) && isObj(f.pending) && Object.values(f.pending).every(validPending)
    && Array.isArray(f.calls) && f.calls.every(validCall)
    && Array.isArray(f.wakes) && f.wakes.every(validWake));
}

/**
 * Incremental backfill of conductor→worker interactions from conductor transcripts.
 * Only owners (sessions that are some session's parent) are scanned. Raw ids are cached;
 * resolution against sessions.json happens at build time. Prompt text is never retained.
 */
export class BackfillIndex {
  constructor({ transcriptRoot, dataDir, buildIndex = buildBackingIndex }) {
    this.buildIndex = buildIndex;
    this.transcriptRoot = transcriptRoot;
    this.dataDir = dataDir;
    this.files = {};
    this.progress = { state: 'scanning', filesDone: 0, filesTotal: 0, missing: 0, corrupt: 0 };
    this.running = null;
    this.rerun = false;
    this.latest = null;
    try {
      dataDir.remove(LEGACY_CACHE); // best effort: a directory or an outside symlink there must not stop the boot
    } catch (err) {
      console.warn(`[code-gantt] could not remove the legacy cache ${LEGACY_CACHE}: ${err.message}`);
    }
    const cached = dataDir.readJson(CACHE);
    if (validCache(cached)) this.files = cached.files;
    else if (cached) console.warn('[code-gantt] backfill cache invalid or wrong version; rebuilding');
  }

  status() {
    // wake markers beyond the per-line caps (see extract.js), summed over the cached files
    const droppedMarkers = Object.values(this.files).reduce((n, f) => n + (f.dropped ?? 0), 0);
    return { ...this.progress, droppedMarkers };
  }

  persist() {
    this.dataDir.writeJsonAtomic(CACHE, { version: VERSION, files: this.files });
  }

  /**
   * One pass over every owner transcript. A request made while a pass is running is not dropped:
   * the latest `byId` is remembered and one follow-up pass runs, so repeated requests coalesce.
   */
  scan(byId, { onProgress } = {}) {
    this.latest = { byId, onProgress };
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        const { byId: b, onProgress: p } = this.latest;
        await this.#scan(b, p);
      } while (this.rerun);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async #scan(byId, onProgress) {
    const owners = new Set();
    for (const rec of byId.values()) if (rec.parent && byId.has(rec.parent)) owners.add(rec.parent);

    let backing = null;
    let refreshed = false; // the backing index is rebuilt at most once per pass
    let missing = 0;
    const targets = [];
    for (const owner of owners) {
      for (const seg of byId.get(owner).segments ?? []) {
        if (!seg?.id || seg.dropped) continue;
        let p = (backing ??= await this.buildIndex(this.transcriptRoot)).get(seg.id);
        if (!p && !refreshed) {
          refreshed = true;
          backing = await this.buildIndex(this.transcriptRoot); // refresh on first miss
          p = backing.get(seg.id);
        }
        if (p) targets.push({ path: p, owner });
        else missing++;
      }
    }
    this.progress = { ...this.progress, state: 'scanning', filesDone: 0, filesTotal: targets.length, missing };
    onProgress?.(this.status());

    let done = 0;
    for (const t of targets) {
      await this.#scanFile(t);
      done++;
      this.progress.filesDone = done;
      if (done % PERSIST_EVERY === 0) {
        this.persist();
        onProgress?.(this.status());
      }
    }
    this.persist();
    this.progress.state = 'ready';
    onProgress?.(this.status());
  }

  async #scanFile({ path, owner }) {
    const st = (this.files[path] ??= { size: 0, offset: 0, owner, pending: {}, calls: [], wakes: [] });
    st.owner = owner;
    const r = await readFrom(path, st.offset, { filter: prefilter });
    if (r.missing) return;
    if (r.reset) Object.assign(st, { pending: {}, calls: [], wakes: [], dropped: 0 });
    this.progress.corrupt += r.corrupt.length;
    if (r.corrupt.length) console.warn(`[code-gantt] ${r.corrupt.length} corrupt line(s) in ${path} at byte ${r.corrupt.map((c) => c.byteOffset).join(',')}`);
    let wakeKeys = null; // built lazily, only when a wake arrives
    for (const { value } of r.lines) {
      for (const ev of extractLine(value)) {
        if (ev.k === 'call') {
          const { k, ...rest } = ev;
          st.pending[ev.id] = rest;
        } else if (ev.k === 'result') {
          if (!Object.hasOwn(st.pending, ev.id)) continue; // never an inherited member such as `constructor`
          const c = st.pending[ev.id];
          delete st.pending[ev.id];
          st.calls.push({ ...c, ok: ev.ok, ...(Number.isFinite(ev.ts) ? { rts: ev.ts } : {}) });
        } else if (ev.k === 'dropped') {
          st.dropped = (st.dropped ?? 0) + ev.count;
        } else {
          wakeKeys ??= new Set(st.wakes.map((w) => w.key));
          if (wakeKeys.has(ev.key)) continue;
          wakeKeys.add(ev.key);
          const { k, ...rest } = ev;
          st.wakes.push(rest);
        }
      }
    }
    st.offset = r.offset;
    st.size = r.size;
  }

  /** Resolved (non-pending) calls and wakes with their owner, deduplicated across an owner's files. */
  collect() {
    const calls = new Map();
    const wakes = new Map();
    for (const st of Object.values(this.files)) {
      for (const c of st.calls) {
        const key = `${st.owner}|${c.id}`;
        const prev = calls.get(key);
        if (!prev || (c.ok && !prev.ok)) calls.set(key, { ...c, owner: st.owner });
      }
      for (const w of st.wakes) wakes.set(`${st.owner}|${w.key}`, { ...w, owner: st.owner });
    }
    return { calls: [...calls.values()], wakes: [...wakes.values()] };
  }
}
