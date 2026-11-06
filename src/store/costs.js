import { readFrom } from '../jsonlTail.js';

/** Incremental reader of costs.jsonl → per-session turn intervals. */
export class CostsReader {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.turnsBySession = new Map();
    this.corruptLines = 0;
    this.missing = false;
  }

  async refresh() {
    const r = await readFrom(this.file, this.offset);
    this.missing = r.missing;
    if (r.reset) {
      this.turnsBySession = new Map();
      this.corruptLines = 0;
    }
    this.offset = r.offset;
    this.corruptLines += r.corrupt.length;
    for (const { value } of r.lines) {
      if (!value || typeof value.sessionId !== 'string' || !Number.isFinite(value.ts)) continue;
      const dur = Number.isFinite(value.duration_ms) ? Math.max(0, value.duration_ms) : 0;
      let list = this.turnsBySession.get(value.sessionId);
      if (!list) this.turnsBySession.set(value.sessionId, (list = []));
      list.push([value.ts - dur, value.ts]);
    }
  }
}
