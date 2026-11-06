import { resolveId } from './resolve.js';
import { GOVERNED_TOOLS, OTHER_LINK_TYPE } from './linkTypes.js';

const GOVERNED = new Set(GOVERNED_TOOLS);
const DEDUPE_WINDOW_MS = 120_000;
// How far a backfill event's completion time (result line; transcript line for wakes) may sit from its
// ledger twin: the ledger entry and the result line are both written after the handler returns.
const BOUNDARY_WINDOW_MS = 30_000;
const startOf = (rec) => Date.parse(rec.segments?.[0]?.at) || 0;

/**
 * Derives typed links from the cc store (sessions.json spawn edges, ledger events) and from
 * the transcript backfill.
 *
 * - Backfill events at/after `cutoffTs` (first ledger interaction|wake) are dropped.
 * - A stage-moving call writes only a `transition`; it draws a link itself, so a call or ledger
 *   interaction matching a transition (same target and tool == via, within ±120 s, one-to-one
 *   nearest first) is dropped.
 * - A ledger `interaction` whose tool is not governed becomes type `other` and is counted in `unknownTools`.
 *
 * `source: 'ledger'` marks every link derived from the cc store; `'backfill'` marks transcript-derived ones.
 */
export function buildLinks({ sessions, ledger, backfill, cutoffTs }) {
  const { byId, byBacking, forest } = sessions;
  const treeOf = new Map();
  for (const t of forest?.trees ?? []) {
    const ids = new Set(t.rows.map((r) => r.id));
    for (const id of ids) treeOf.set(id, ids);
  }
  let unresolved = 0;
  const unknownTools = new Map(); // tool names come from files: never a plain object
  // `count` (a boolean or a function) says whether a failed resolution is added to the diagnostic. It is
  // false for events whose ledger counterpart counts the same id already.
  const resolve = (raw, scopeId, count = true) => {
    const id = resolveId(raw, { byId, byBacking, scope: scopeId ? treeOf.get(scopeId) ?? null : null });
    if (!id && (typeof count === 'function' ? count() : count)) unresolved++;
    return id;
  };
  const links = [];
  const push = (l) => links.push(l);

  for (const [id, rec] of byId) {
    if (rec.parent && byId.has(rec.parent)) push({ ts: startOf(rec), type: 'spawn', from: rec.parent, to: id, source: 'ledger' });
  }

  // candidate stage-moving transitions and the interactions that may duplicate them
  const transitions = [];
  const candidates = []; // {link, target, tool}
  const ledgerRefs = []; // ledger interaction/wake links a backfilled twin may duplicate
  const backfillCands = []; // surviving backfill links, pending boundary dedupe
  const typeOfTool = (tool) => {
    if (GOVERNED.has(tool)) return tool;
    unknownTools.set(tool ?? '', (unknownTools.get(tool ?? '') ?? 0) + 1);
    return OTHER_LINK_TYPE;
  };

  for (const ev of ledger) {
    if (!Number.isFinite(ev.ts)) continue;
    if (ev.kind === 'transition') {
      const to = resolve(ev.sessionId);
      if (!to) continue;
      const parent = byId.get(to).parent;
      const type = ev.forwardSessionId ? 'forward' : GOVERNED.has(ev.via) ? ev.via : OTHER_LINK_TYPE;
      let from = parent && byId.has(parent) ? parent : null;
      if (ev.forwardSessionId) from = resolve(ev.forwardSessionId, to);
      if (!from) continue;
      transitions.push({ ts: ev.ts, target: to, via: ev.via });
      push({ ts: ev.ts, type, from, to, source: 'ledger' });
    } else if (ev.kind === 'interaction') {
      const to = resolve(ev.sessionId);
      const cond = resolve(ev.conductorSessionId, to);
      if (!to || !cond) continue;
      const tool = typeOfTool(ev.tool);
      let from = cond;
      let type = tool;
      if (ev.forwardSessionId) {
        from = resolve(ev.forwardSessionId, to);
        type = 'forward';
        if (!from) continue;
      }
      const link = { ts: ev.ts, type, from, to, source: 'ledger' };
      candidates.push({ link, target: to, tool: ev.tool, et: ev.ts });
    } else if (ev.kind === 'wake') {
      const worker = resolve(ev.sessionId);
      const cond = resolve(ev.conductorSessionId, worker);
      if (!worker || !cond) continue;
      const link = { ts: ev.ts, type: 'wake', from: worker, to: cond, source: 'ledger', ...(ev.heartbeat ? { heartbeat: true } : {}) };
      push(link);
      ledgerRefs.push(link);
    }
  }

  // A backfilled call's `ts` is its tool_use line (before the handler runs, minutes before for a parked
  // send_prompt); its `rts` is the tool_result line, written after the handler like the ledger entry. All
  // cutoff and twin decisions use `et` = rts when known, so they do not depend on how long the handler took.
  const afterCutoff = (et) => cutoffTs != null && et >= cutoffTs;
  // A pairable backfill event just before the cutoff whose raw id a ledger entry just after it also names is
  // that entry's twin: the ledger entry counts the id, so the backfill event must not count it again.
  const hasLedgerTwin = (kind, rawId, et) => cutoffTs != null
    && ledger.some((ev) => ev.kind === kind && ev.sessionId === rawId && ev.ts >= cutoffTs && Math.abs(et - ev.ts) <= BOUNDARY_WINDOW_MS);
  for (const c of backfill.calls) {
    if (!c.ok) continue;
    const et = c.rts ?? c.ts;
    // cc appends the ledger entry before the result line is written, so a call whose result is known and
    // landed at or after the cutoff always has its ledger entry: drop it before resolving anything.
    if (c.rts !== undefined && afterCutoff(et)) continue;
    // only a call without a result time can still reach here after the cutoff
    const count = () => !afterCutoff(et) && !(c.rts === undefined && hasLedgerTwin('interaction', c.target, et));
    const to = resolve(c.target, c.owner, count);
    if (!to) continue;
    let from = resolve(c.owner, undefined, count);
    let type = typeOfTool(c.tool); // cached values are untrusted: anything ungoverned is `other`
    if (c.forward) {
      from = resolve(c.forward, c.owner, count);
      type = 'forward';
    }
    if (!from) continue;
    // Without a result time the tool_use time may precede the handler by minutes, so such a call can only
    // be matched to a ledger twin by pairing; with one, the cutoff rule above is exact and pairing would
    // only risk eating a genuine call.
    candidates.push({ link: { ts: c.ts, type, from, to, source: 'backfill' }, target: to, tool: c.tool, et, pairable: c.rts === undefined });
  }
  for (const w of backfill.wakes) {
    const count = () => !afterCutoff(w.ts) && !hasLedgerTwin('wake', w.worker, w.ts);
    const worker = resolve(w.worker, w.owner, count);
    const owner = resolve(w.owner, undefined, count);
    if (!worker || !owner) continue;
    // wakes have no result line: their transcript time is all there is, so they are matched by pairing
    backfillCands.push({ link: { ts: w.ts, type: 'wake', from: worker, to: owner, source: 'backfill', ...(w.heartbeat ? { heartbeat: true } : {}) }, et: w.ts, pairable: true });
  }

  // one-to-one nearest-first transition dedupe
  const pairs = [];
  transitions.forEach((t, ti) => candidates.forEach((c, ci) => {
    const dt = Math.abs(c.et - t.ts);
    if (c.target === t.target && c.tool === t.via && dt <= DEDUPE_WINDOW_MS) pairs.push({ ti, ci, dt });
  }));
  pairs.sort((a, b) => a.dt - b.dt);
  const usedT = new Set();
  const dropped = new Set();
  for (const p of pairs) {
    if (usedT.has(p.ti) || dropped.has(p.ci)) continue;
    usedT.add(p.ti);
    dropped.add(p.ci);
  }
  candidates.forEach((c, ci) => {
    if (dropped.has(ci)) return;
    if (c.link.source === 'ledger') {
      push(c.link);
      ledgerRefs.push(c.link);
    } else {
      backfillCands.push({ link: c.link, et: c.et, pairable: c.pairable });
    }
  });

  // Cutoff: the ledger is authoritative from its first interaction|wake. A backfill event that completed
  // at or after the cutoff is the ledger's; one that completed before it is kept, unless it is the twin of
  // a ledger entry written just after the cutoff. Twin pairing is one-to-one, nearest first, and applies
  // only to events whose time precedes their ledger entry by an unknown skew: wakes (transcript time) and
  // calls without a result time.
  const near = new Set();
  if (cutoffTs != null) {
    const poolBf = [];
    backfillCands.forEach((b, bi) => { if (b.pairable && b.et >= cutoffTs - BOUNDARY_WINDOW_MS && b.et <= cutoffTs + BOUNDARY_WINDOW_MS) poolBf.push(bi); });
    const poolLd = ledgerRefs.filter((l) => l.ts >= cutoffTs && l.ts <= cutoffTs + 2 * BOUNDARY_WINDOW_MS);
    const twins = [];
    for (const bi of poolBf) {
      const b = backfillCands[bi];
      poolLd.forEach((l, li) => {
        const dt = Math.abs(b.et - l.ts);
        if (b.link.type === l.type && b.link.from === l.from && b.link.to === l.to && Boolean(b.link.heartbeat) === Boolean(l.heartbeat) && dt <= BOUNDARY_WINDOW_MS) twins.push({ bi, li, dt });
      });
    }
    twins.sort((a, b) => a.dt - b.dt);
    const usedL = new Set();
    for (const t of twins) {
      if (usedL.has(t.li) || near.has(t.bi)) continue;
      usedL.add(t.li);
      near.add(t.bi);
    }
  }
  backfillCands.forEach((b, bi) => {
    if (near.has(bi)) return;
    if (cutoffTs != null && b.et >= cutoffTs) return;
    push(b.link);
  });

  links.sort((a, b) => a.ts - b.ts);
  return { links, unresolved, unknownTools: Object.fromEntries(unknownTools) };
}
