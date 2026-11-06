import { buildForest, groupByProject } from './tree.js';
import { buildLinks } from './links.js';
import { buildBar } from './bars.js';
import { resolveId } from './resolve.js';
import { LINK_TYPES } from './linkTypes.js';

const DEFAULT_WINDOW_MS = 72 * 3600_000;
const OWN_KINDS = new Set(['spawn', 'transition', 'retire', 'resume']);

function clipTurns(turns, from, to) {
  const out = [];
  for (const [s, e] of turns) {
    if (e < from || s > to) continue;
    out.push([Math.max(s, from), Math.min(e, to)]);
  }
  return out;
}

/** Builds the `api/gantt` payload for a window from the current state snapshot. */
export function buildPayload(state, { from, to, now = Date.now() } = {}) {
  to ??= now;
  from ??= to - DEFAULT_WINDOW_MS;
  const { byId, byBacking } = state.sessions;
  const forest = buildForest(byId);
  const groups = groupByProject(forest.trees);
  const treeByRoot = new Map(forest.trees.map((t) => [t.rootId, t]));
  const ids = { byId, byBacking };
  const idOf = (raw) => resolveId(raw, ids);

  const { links: allLinks, unresolved, unknownTools } = buildLinks({
    sessions: { byId, byBacking, forest },
    ledger: state.ledger.events,
    backfill: state.backfill.collect(),
    cutoffTs: state.ledger.cutoffTs,
  });

  const own = new Map();
  const namedMax = new Map();
  const unmatched = { ledger: 0, costs: 0 }; // rows of sessions absent from sessions.json
  for (const ev of state.ledger.events) {
    if (ev.sessionId && !idOf(ev.sessionId)) unmatched.ledger++;
    for (const raw of [ev.sessionId, ev.conductorSessionId, ev.forwardSessionId]) {
      const id = raw && idOf(raw);
      if (id && Number.isFinite(ev.ts)) namedMax.set(id, Math.max(namedMax.get(id) ?? 0, ev.ts));
    }
    const id = ev.sessionId && idOf(ev.sessionId);
    if (id && OWN_KINDS.has(ev.kind)) (own.get(id) ?? own.set(id, []).get(id)).push(ev);
  }

  const turns = new Map();
  for (const [raw, list] of state.costs.turnsBySession) {
    const id = idOf(raw);
    if (id) turns.set(id, [...(turns.get(id) ?? []), ...list]);
    else unmatched.costs += list.length;
  }
  for (const list of turns.values()) list.sort((a, b) => a[1] - b[1]);

  const linkTs = new Map();
  const kills = new Map();
  for (const l of allLinks) {
    for (const id of [l.from, l.to]) linkTs.set(id, Math.max(linkTs.get(id) ?? 0, l.ts));
    if (l.type === 'kill_instance') (kills.get(l.to) ?? kills.set(l.to, []).get(l.to)).push(l.ts);
  }

  const orphanRoots = new Set(forest.trees.filter((t) => t.orphan).map((t) => t.rootId));
  const bars = new Map();
  const barOf = (id) => {
    if (bars.has(id)) return bars.get(id);
    const rec = byId.get(id);
    const t = turns.get(id) ?? [];
    const bar = buildBar(rec, {
      own: own.get(id) ?? [],
      namedMaxTs: namedMax.get(id) ?? 0,
      turns: t,
      turnRows: t.length,
      linkTs: linkTs.get(id) ?? 0,
      kills: kills.get(id) ?? [],
      live: state.liveSet?.has(id) ?? false,
      now,
    });
    bars.set(id, bar);
    return bar;
  };
  const overlaps = (id) => {
    const b = barOf(id);
    return b.start <= to && (b.end ?? now) >= from;
  };

  const sessions = {};
  const projects = [];
  for (const g of groups) {
    const trees = [];
    for (const t of g.trees) {
      if (!t.rows.some((r) => !r.context && overlaps(r.id))) continue;
      const rows = t.rows.filter((r) => r.context || overlaps(r.id));
      trees.push({ rootId: t.rootId, rows });
      for (const r of rows) {
        if (sessions[r.id]) continue;
        const rec = byId.get(r.id);
        const bar = barOf(r.id);
        const s = { ...bar, turns: clipTurns(bar.turns, from, to) };
        for (const k of ['title', 'project', 'worktree', 'parent']) if (rec[k] != null) s[k] = rec[k];
        if (rec.backend?.model) s.model = rec.backend.model;
        if (orphanRoots.has(r.id)) s.orphan = true;
        sessions[r.id] = s;
      }
    }
    if (trees.length) projects.push({ project: g.project, trees });
  }

  const links = allLinks.filter((l) => l.ts >= from && l.ts <= to && sessions[l.from] && sessions[l.to]);

  const missing = [];
  if (state.sessions.missing) missing.push('sessions.json');
  if (state.ledger.missing) missing.push('playbook-ledger.jsonl');
  if (state.costs.missing) missing.push('costs.jsonl');
  const errors = state.sessions.error ? [state.sessions.error] : [];
  const bf = state.backfill.status();

  return {
    now,
    window: { from, to },
    version: state.version,
    linkTypes: LINK_TYPES,
    projects,
    sessions,
    links,
    diagnostics: {
      liveness: state.liveSet ? 'ok' : 'unavailable',
      backfill: bf,
      cutoff: state.ledger.cutoffTs == null ? null : new Date(state.ledger.cutoffTs).toISOString(),
      unresolved,
      unmatchedStoreRows: unmatched,
      unknownTools,
      unknownKinds: state.ledger.unknownKinds,
      corruptLines: state.ledger.corruptLines + state.costs.corruptLines + bf.corrupt,
      treeLoops: forest.loops,
      missing,
      errors,
    },
  };
}
