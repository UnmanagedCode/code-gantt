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

/** A section is one owner's rows in one band; a link line never leaves it. */
const sectionOf = (r) => `${r.group}/${r.section}`;

/** Row anchor of a link end: its own (non-context) row, else the first (topmost) copy. */
const anchor = (rows, sec) => {
  const inSec = sec === undefined ? rows : rows.filter((r) => sectionOf(r) === sec);
  return inSec.find((r) => !r.context) ?? inSec[0];
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

  // role and tree are per session, so any row pair decides
  const rootLead = (x, y) => x.head === 'conductor' && y.head === 'lead' && y.rootId === x.id;
  const links = [];
  const stubs = [];
  payload.links.forEach((l, i) => {
    const visible = l.type === 'wake' && l.heartbeat ? f.heartbeat : f.linkTypes.has(l.type);
    if (!visible || l.ts < f.from || l.ts > f.to) return;
    const a = rowsOf.get(l.from);
    const b = rowsOf.get(l.to);
    if (!a || !b) return;
    // the sections holding both ends; the line goes in the one where most ends have their own row, ties to the first in row order
    const shared = [...new Set(a.map(sectionOf))].filter((sec) => b.some((r) => sectionOf(r) === sec));
    let best = null;
    let bestHome = -1;
    for (const sec of shared) {
      const home = [a, b].filter((rs) => rs.some((r) => sectionOf(r) === sec && !r.context)).length;
      if (home > bestHome) { best = sec; bestHome = home; }
    }
    if (best != null) {
      links.push({ ...l, key: `l:${i}`, y1: centre(anchor(a, best)), y2: centre(anchor(b, best)) });
      // a root and its own section lead are repeated in each of the lead's sections: draw the link there too
      if (rootLead(a[0], b[0]) || rootLead(b[0], a[0])) {
        for (const sec of shared) if (sec !== best) links.push({ ...l, key: `l:${i}:${sec}`, y1: centre(anchor(a, sec)), y2: centre(anchor(b, sec)) });
      }
      return;
    }
    // no shared section: no line, a stub at each end pointing at the other end's row
    const ra = anchor(a);
    const rb = anchor(b);
    const stub = (end, own, other) => ({
      ...l, key: `s:${i}:${end}`, end, y: centre(own), dir: Math.sign(other.y - own.y), otherId: end === 'source' ? l.to : l.from, otherGroup: other.group,
    });
    stubs.push(stub('source', ra, rb), stub('target', rb, ra));
  });

  return { rows, links, stubs, height: y };
}
