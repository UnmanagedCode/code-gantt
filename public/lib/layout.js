// Pure filtering + row layout: payload + filters → rows (with y), links (with y1/y2) and link stubs.
import { groupRows } from './grouping.js';

export const ROW_H = 26;
export const HEADER_H = 24;

export function defaultFilters(payload) {
  return {
    projects: null, // null = all; a Set = exactly these project names (an empty Set = none)
    roots: null, // null = all; a Set = exactly these tree root ids (an empty Set = none)
    from: payload.window.from,
    to: payload.window.to,
    linkTypes: new Set(payload.linkTypes),
    heartbeat: true, // heartbeat wakes are controlled only by this toggle
  };
}

/** Row anchor of a link end: its own (non-context) row, else the first (topmost) copy. */
const anchor = (rows, group) => {
  const inGroup = group === undefined ? rows : rows.filter((r) => r.group === group);
  return inGroup.find((r) => !r.context) ?? inGroup[0];
};

export function applyFilters(payload, f) {
  const grouped = groupRows(payload.trees, payload.sessions, {
    roots: f.roots, projects: f.projects, from: f.from, to: f.to, now: payload.now, conductorProject: payload.conductorProject,
  });
  const rows = [];
  let y = 0;
  for (const r of grouped) {
    rows.push({ ...r, y });
    y += r.kind === 'band' ? HEADER_H : ROW_H;
  }

  const rowsOf = new Map();
  for (const r of rows) if (r.kind === 'row') (rowsOf.get(r.id) ?? rowsOf.set(r.id, []).get(r.id)).push(r);
  const centre = (r) => r.y + ROW_H / 2;

  const links = [];
  const stubs = [];
  payload.links.forEach((l, i) => {
    const visible = l.type === 'wake' && l.heartbeat ? f.heartbeat : f.linkTypes.has(l.type);
    if (!visible || l.ts < f.from || l.ts > f.to) return;
    const a = rowsOf.get(l.from);
    const b = rowsOf.get(l.to);
    if (!a || !b) return;
    // the group holding both ends where most of them have their own row; ties go to the first in row order
    let best = null;
    let bestHome = -1;
    for (const g of new Set(a.map((r) => r.group))) {
      if (!b.some((r) => r.group === g)) continue;
      const home = [a, b].filter((rs) => rs.some((r) => r.group === g && !r.context)).length;
      if (home > bestHome) { best = g; bestHome = home; }
    }
    if (best != null) {
      links.push({ ...l, key: `l:${i}`, y1: centre(anchor(a, best)), y2: centre(anchor(b, best)) });
      return;
    }
    // no shared group: no line, a stub at each end pointing at the other end's row
    const ra = anchor(a);
    const rb = anchor(b);
    const stub = (end, own, other) => ({
      ...l, key: `s:${i}:${end}`, end, y: centre(own), dir: Math.sign(other.y - own.y), otherId: end === 'source' ? l.to : l.from, otherGroup: other.group,
    });
    stubs.push(stub('source', ra, rb), stub('target', rb, ra));
  });

  return { rows, links, stubs, height: y };
}
