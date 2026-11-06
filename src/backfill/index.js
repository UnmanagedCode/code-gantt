import { readFrom } from '../jsonlTail.js';
import { buildBackingIndex } from './locate.js';
import { extractLine } from './extract.js';

const CACHE = 'backfill-v1.json';
const VERSION = 1;
const PERSIST_EVERY = 10;
const PREFILTER = ['mcp__code-conductor__', '[[cc:wake-callback]]', '"tool_result"'];
const prefilter = (line) => PREFILTER.some((p) => line.includes(p));

/**
 * Incremental backfill of conductor→worker interactions from conductor transcripts.
 * Only owners (sessions that are some session's parent) are scanned. Raw ids are cached;
 * resolution against sessions.json happens at build time. Prompt text is never retained.
 */
export class BackfillIndex {
  constructor({ transcriptRoot, dataDir }) {
    this.transcriptRoot = transcriptRoot;
    this.dataDir = dataDir;
    this.files = {};
    this.progress = { state: 'scanning', filesDone: 0, filesTotal: 0, missing: 0, corrupt: 0 };
    this.running = null;
    const cached = dataDir.readJson(CACHE);
    if (cached?.version === VERSION && cached.files && typeof cached.files === 'object') this.files = cached.files;
    else if (cached) console.warn('[code-gantt] backfill cache unreadable or wrong version; rebuilding');
  }

  status() {
    return { ...this.progress };
  }

  persist() {
    this.dataDir.writeJsonAtomic(CACHE, { version: VERSION, files: this.files });
  }

  /** One pass over every owner transcript. Overlapping calls share the running pass. */
  scan(byId, { onProgress } = {}) {
    if (!this.running) this.running = this.#scan(byId, onProgress).finally(() => { this.running = null; });
    return this.running;
  }

  async #scan(byId, onProgress) {
    const owners = new Set();
    for (const rec of byId.values()) if (rec.parent && byId.has(rec.parent)) owners.add(rec.parent);

    let backing = null;
    let missing = 0;
    const targets = [];
    for (const owner of owners) {
      for (const seg of byId.get(owner).segments ?? []) {
        if (!seg?.id || seg.dropped) continue;
        let p = (backing ??= await buildBackingIndex(this.transcriptRoot)).get(seg.id);
        if (!p) {
          backing = await buildBackingIndex(this.transcriptRoot); // refresh on miss
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
    if (r.reset) Object.assign(st, { pending: {}, calls: [], wakes: [] });
    this.progress.corrupt += r.corrupt.length;
    if (r.corrupt.length) console.warn(`[code-gantt] ${r.corrupt.length} corrupt line(s) in ${path} at byte ${r.corrupt.map((c) => c.byteOffset).join(',')}`);
    for (const { value } of r.lines) {
      for (const ev of extractLine(value)) {
        if (ev.k === 'call') {
          const { k, ...rest } = ev;
          st.pending[ev.id] = rest;
        } else if (ev.k === 'result') {
          const c = st.pending[ev.id];
          if (!c) continue;
          delete st.pending[ev.id];
          st.calls.push({ ...c, ok: ev.ok });
        } else if (!st.wakes.some((w) => w.key === ev.key)) {
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
