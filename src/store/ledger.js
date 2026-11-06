import { readFrom } from '../jsonlTail.js';
import { createSerializer } from '../serial.js';

const KEPT = new Set(['spawn', 'transition', 'retire', 'resume', 'interaction', 'wake']);
const IGNORED = new Set(['refusal', 'enforcement']);
const MCP_PREFIX = 'mcp__code-conductor__';
const FIELDS = ['sessionId', 'conductorSessionId', 'forwardSessionId', 'from', 'to', 'via', 'stage', 'playbook', 'reason'];

/** Incremental reader of playbook-ledger.jsonl. Events keep file (line) order; `seq` is never used. */
export class LedgerReader {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.lines = 0;
    this.events = [];
    this.cutoffTs = null;
    this.unknown = new Map(); // a Map: kinds come from the file and may be named like Object.prototype members
    this.corruptLines = 0;
    this.missing = false;
    this.serialize = createSerializer();
  }

  /** @returns {Promise<object[]>} the events added by this pass */
  /** Unknown kinds seen so far: `{kind: count}`. */
  get unknownKinds() {
    return Object.fromEntries(this.unknown);
  }

  /** Serialised: concurrent calls run one after another, so no line is ever read twice. */
  refresh() {
    return this.serialize(() => this.#refresh());
  }

  async #refresh() {
    const r = await readFrom(this.file, this.offset);
    this.missing = r.missing;
    if (r.reset) {
      this.events = [];
      this.lines = 0;
      this.cutoffTs = null;
      this.unknown = new Map();
      this.corruptLines = 0;
    }
    this.offset = r.offset;
    this.corruptLines += r.corrupt.length;
    if (r.corrupt.length) console.warn(`[code-gantt] ${r.corrupt.length} corrupt line(s) in ${this.file} at byte ${r.corrupt.map((c) => c.byteOffset).join(',')}`);
    const added = [];
    for (const { value } of r.lines) {
      const line = this.lines++;
      if (!value || typeof value !== 'object') continue;
      const kind = value.kind;
      if (IGNORED.has(kind)) continue;
      if (!KEPT.has(kind)) {
        const k = String(kind);
        this.unknown.set(k, (this.unknown.get(k) ?? 0) + 1);
        continue;
      }
      const ev = { line, ts: Date.parse(value.ts), kind };
      for (const f of FIELDS) if (value[f] != null) ev[f] = value[f];
      if (typeof value.tool === 'string') ev.tool = value.tool.startsWith(MCP_PREFIX) ? value.tool.slice(MCP_PREFIX.length) : value.tool;
      if (value.heartbeat) ev.heartbeat = true;
      if ((kind === 'interaction' || kind === 'wake') && this.cutoffTs == null && Number.isFinite(ev.ts)) this.cutoffTs = ev.ts;
      this.events.push(ev);
      added.push(ev);
    }
    return added;
  }
}
