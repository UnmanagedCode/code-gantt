import { readFrom } from '../jsonlTail.js';
import { createSerializer } from '../serial.js';

/** The `v` of the rows this reader understands (cc docs/event-log.md). */
export const EVENT_LOG_VERSION = 1;

const KINDS = new Set(['call', 'session', 'turn', 'wake', 'config']);
const ACTOR_TYPES = new Set(['conductor', 'human', 'system']);
const str = (x) => (typeof x === 'string' && x ? x : undefined);

function pair(o, a, b) {
  if (!o || typeof o !== 'object') return undefined;
  const x = str(o[a]);
  const y = str(o[b]);
  return x && y ? { [a]: x, [b]: y } : undefined;
}

/** Copies only the typed fields of a row that the plugin uses; anything else is never carried over. */
function normalise(value, kind) {
  const actor = { type: ACTOR_TYPES.has(value.actor?.type) ? value.actor.type : 'system' };
  const sid = str(value.actor?.sessionId);
  if (sid) actor.sessionId = sid;
  const ev = { ts: Date.parse(value.ts), kind, actor };
  const subject = str(value.subject);
  if (subject) ev.subject = subject;
  const set = (k, v) => { if (v !== undefined) ev[k] = v; };
  if (kind === 'call') {
    set('tool', str(value.tool));
    set('outcome', str(value.outcome));
    set('forward', str(value.forward));
    set('move', pair(value.move, 'from', 'to'));
    set('bind', pair(value.bind, 'playbook', 'stage'));
  } else if (kind === 'session') {
    set('event', str(value.event));
    set('cause', str(value.cause));
  } else if (kind === 'turn') {
    set('event', str(value.event));
  } else if (kind === 'wake') {
    set('recipient', str(value.recipient));
    if (value.heartbeat === true) ev.heartbeat = true;
  }
  return ev;
}

/** Incremental reader of events.jsonl (contract: cc docs/event-log.md). Rows keep line order; `ts` is informational. */
export class EventLogReader {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.events = [];
    this.#firstLinkTs = null;
    this.#firstTurnTs = null;
    this.unknown = new Map(); // a Map: kinds come from the file and may be named like Object.prototype members
    this.corruptLines = 0;
    this.otherVersionRows = 0;
    this.warnedVersion = false;
    this.missing = false;
    this.serialize = createSerializer();
  }

  #firstLinkTs; // first wake, or first call naming its caller: links are complete from here
  #firstTurnTs; // first `turn` row: turns are complete from here

  /**
   * The moment the log is complete for both links and turns: the later of its first wake-or-attributed-call
   * row and its first `turn` row. `null` while either is missing. Nothing before it is drawn.
   */
  get horizonTs() {
    return this.#firstLinkTs == null || this.#firstTurnTs == null ? null : Math.max(this.#firstLinkTs, this.#firstTurnTs);
  }

  /** Unknown kinds seen so far: `{kind: count}`. */
  get unknownKinds() {
    return Object.fromEntries(this.unknown);
  }

  /** Serialised: concurrent calls run one after another, so no line is ever read twice. @returns {Promise<object[]>} rows added */
  refresh() {
    return this.serialize(() => this.#refresh());
  }

  async #refresh() {
    const r = await readFrom(this.file, this.offset);
    this.missing = r.missing;
    if (r.reset) {
      this.events = [];
      this.#firstLinkTs = null;
      this.#firstTurnTs = null;
      this.unknown = new Map();
      this.corruptLines = 0;
      this.otherVersionRows = 0;
    }
    this.offset = r.offset;
    this.corruptLines += r.corrupt.length;
    if (r.corrupt.length) console.warn(`[code-gantt] ${r.corrupt.length} corrupt line(s) in ${this.file} at byte ${r.corrupt.map((c) => c.byteOffset).join(',')}`);
    const added = [];
    for (const { value } of r.lines) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (value.v !== EVENT_LOG_VERSION) {
        this.otherVersionRows++;
        if (!this.warnedVersion) {
          this.warnedVersion = true;
          console.warn(`[code-gantt] ${this.file} has rows with v=${String(value.v)}; only v=${EVENT_LOG_VERSION} is read`);
        }
        continue;
      }
      const kind = value.kind;
      if (!KINDS.has(kind)) {
        const k = String(kind);
        this.unknown.set(k, (this.unknown.get(k) ?? 0) + 1);
        continue;
      }
      if (kind === 'config') continue;
      const ev = normalise(value, kind);
      if (Number.isFinite(ev.ts)) {
        if (this.#firstLinkTs == null && (kind === 'wake' || (kind === 'call' && ev.actor.sessionId))) this.#firstLinkTs = ev.ts;
        if (this.#firstTurnTs == null && kind === 'turn') this.#firstTurnTs = ev.ts;
      }
      this.events.push(ev);
      added.push(ev);
    }
    return added;
  }
}
