import { resolveId } from './resolve.js';
import { GOVERNED_TOOLS, OTHER_LINK_TYPE } from './linkTypes.js';

const GOVERNED = new Set(GOVERNED_TOOLS);
const DEDUPE_WINDOW_MS = 120_000;
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
  const unknownTools = {};
  const resolve = (raw, scopeId) => {
    const id = resolveId(raw, { byId, byBacking, scope: scopeId ? treeOf.get(scopeId) ?? null : null });
    if (!id) unresolved++;
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
    unknownTools[tool ?? ''] = (unknownTools[tool ?? ''] ?? 0) + 1;
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
      candidates.push({ link, target: to, tool: ev.tool });
    } else if (ev.kind === 'wake') {
      const worker = resolve(ev.sessionId);
      const cond = resolve(ev.conductorSessionId, worker);
      if (!worker || !cond) continue;
      const link = { ts: ev.ts, type: 'wake', from: worker, to: cond, source: 'ledger', ...(ev.heartbeat ? { heartbeat: true } : {}) };
      push(link);
      ledgerRefs.push(link);
    }
  }

  const keep = (e) => cutoffTs == null || e.ts < cutoffTs;
  for (const c of backfill.calls) {
    if (!c.ok || !keep(c)) continue;
    const to = resolve(c.target, c.owner);
    if (!to) continue;
    let from = resolve(c.owner);
    let type = typeOfTool(c.tool); // cached values are untrusted: anything ungoverned is `other`
    if (c.forward) {
      from = resolve(c.forward, c.owner);
      type = 'forward';
    }
    if (!from) continue;
    candidates.push({ link: { ts: c.ts, type, from, to, source: 'backfill' }, target: to, tool: c.tool });
  }
  for (const w of backfill.wakes) {
    if (!keep(w)) continue;
    const worker = resolve(w.worker, w.owner);
    const owner = resolve(w.owner);
    if (!worker || !owner) continue;
    backfillCands.push({ ts: w.ts, type: 'wake', from: worker, to: owner, source: 'backfill', ...(w.heartbeat ? { heartbeat: true } : {}) });
  }

  // one-to-one nearest-first transition dedupe
  const pairs = [];
  transitions.forEach((t, ti) => candidates.forEach((c, ci) => {
    const dt = Math.abs(c.link.ts - t.ts);
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
      backfillCands.push(c.link);
    }
  });

  // Boundary dedupe: the ledger entry is written after the transcript line, so a backfilled call or
  // wake just before the cutoff has a ledger twin (same type and endpoints, within the window).
  const twins = [];
  backfillCands.forEach((b, bi) => ledgerRefs.forEach((l, li) => {
    const dt = Math.abs(b.ts - l.ts);
    if (b.type === l.type && b.from === l.from && b.to === l.to && Boolean(b.heartbeat) === Boolean(l.heartbeat) && dt <= DEDUPE_WINDOW_MS) twins.push({ bi, li, dt });
  }));
  twins.sort((a, b) => a.dt - b.dt);
  const usedL = new Set();
  const twinned = new Set();
  for (const t of twins) {
    if (usedL.has(t.li) || twinned.has(t.bi)) continue;
    usedL.add(t.li);
    twinned.add(t.bi);
  }
  backfillCands.forEach((b, bi) => { if (!twinned.has(bi)) push(b); });

  links.sort((a, b) => a.ts - b.ts);
  return { links, unresolved, unknownTools };
}
