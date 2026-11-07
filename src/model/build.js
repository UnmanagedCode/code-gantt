import { buildForest, groupByProject } from './tree.js';
import { buildLinks } from './links.js';
import { buildBar, clipToHorizon } from './bars.js';
import { resolveId } from './resolve.js';
import { LINK_TYPES } from './linkTypes.js';
import { buildTurns } from './turns.js';

const DEFAULT_WINDOW_MS = 72 * 3600_000;

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
  const horizon = state.events.horizonTs;
  // Nothing is drawable without a horizon, or in a window that ends before it; the requested window is echoed.
  if (horizon == null || to < horizon) {
    return {
      now, window: { from, to }, version: state.version, linkTypes: LINK_TYPES, projects: [], sessions: {}, links: [],
      diagnostics: diagnostics(state, { horizon: horizon == null ? null : new Date(horizon).toISOString(), unresolved: 0, unmatchedStoreRows: { events: 0 }, unknownTools: {}, treeLoops: 0 }),
    };
  }
  from = Math.max(from, horizon);
  const { byId, byBacking } = state.sessions;
  const forest = buildForest(byId);
  const groups = groupByProject(forest.trees);
  const treeByRoot = new Map(forest.trees.map((t) => [t.rootId, t]));
  const ids = { byId, byBacking };
  const idOf = (raw) => resolveId(raw, ids);

  const { links: allLinks, unresolved, unknownTools } = buildLinks({
    sessions: { byId, byBacking, forest },
    events: state.events.events,
  });

  const own = new Map();
  const namedMax = new Map();
  const unmatched = { events: 0 }; // rows of sessions absent from sessions.json
  for (const ev of state.events.events) {
    if (ev.subject && !idOf(ev.subject)) unmatched.events++;
    for (const raw of [ev.subject, ev.actor.sessionId, ev.forward, ev.recipient]) {
      const id = raw && idOf(raw);
      if (id && Number.isFinite(ev.ts)) namedMax.set(id, Math.max(namedMax.get(id) ?? 0, ev.ts));
    }
    const id = ev.subject && idOf(ev.subject);
    // A refused row (under `warn` the call's only row) may carry a bind or move too.
    if (id && (ev.kind === 'session' || (ev.kind === 'call' && (ev.bind || ev.move)))) (own.get(id) ?? own.set(id, []).get(id)).push(ev);
  }

  const rowTurns = buildTurns(state.events.events, idOf);

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
    // An open turn (no `end` yet) is sized after the bar's end is known: it counts as activity at its start
    // for the approximate end, then runs to the bar's end (`now` while live).
    const openTurns = [];
    const t = [];
    for (const [s, e] of rowTurns.get(id) ?? []) {
      const iv = [s, e ?? s];
      if (e == null) openTurns.push(iv);
      t.push(iv);
    }
    t.sort((a, b) => a[1] - b[1]);
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
    for (const iv of openTurns) iv[1] = Math.max(iv[0], bar.end ?? now);
    bars.set(id, bar);
    return bar;
  };
  const overlaps = (id) => {
    const b = barOf(id);
    return b.start <= to && (b.end ?? now) >= from;
  };

  const sessions = new Map(); // keyed by ids from the store: never a plain object
  const projects = [];
  for (const g of groups) {
    const trees = [];
    for (const t of g.trees) {
      if (!t.rows.some((r) => !r.context && overlaps(r.id))) continue;
      const rows = t.rows.filter((r) => r.context || overlaps(r.id));
      trees.push({ rootId: t.rootId, rows });
      for (const r of rows) {
        if (sessions.has(r.id)) continue;
        const rec = byId.get(r.id);
        const bar = barOf(r.id);
        const s = clipToHorizon({ ...bar, turns: clipTurns(bar.turns, from, to) }, horizon);
        for (const k of ['title', 'project', 'worktree', 'parent']) if (rec[k] != null) s[k] = rec[k];
        if (rec.backend?.model) s.model = rec.backend.model;
        if (orphanRoots.has(r.id)) s.orphan = true;
        sessions.set(r.id, s);
      }
    }
    if (trees.length) projects.push({ project: g.project, trees });
  }

  const links = allLinks.filter((l) => l.ts >= from && l.ts <= to && sessions.has(l.from) && sessions.has(l.to));

  return {
    now,
    window: { from, to },
    version: state.version,
    linkTypes: LINK_TYPES,
    projects,
    sessions: Object.fromEntries(sessions),
    links,
    diagnostics: diagnostics(state, {
      horizon: new Date(horizon).toISOString(),
      unresolved,
      unmatchedStoreRows: unmatched,
      unknownTools,
      treeLoops: forest.loops,
    }),
  };
}

function diagnostics(state, own) {
  const missing = [];
  if (state.sessions.missing) missing.push('sessions.json');
  if (state.events.missing) missing.push('events.jsonl');
  return {
    liveness: state.liveSet ? 'ok' : 'unavailable',
    ...own,
    unknownKinds: state.events.unknownKinds,
    otherVersionRows: state.events.otherVersionRows,
    corruptLines: state.events.corruptLines,
    missing,
    errors: state.sessions.error ? [state.sessions.error] : [],
  };
}
