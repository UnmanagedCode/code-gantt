// Pure filtering + row layout: payload + filters → rows (with y), links (with y1/y2).

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

const wants = (set, v) => !set || set.has(v);

export function applyFilters(payload, f) {
  const overlaps = (id) => {
    const s = payload.sessions[id];
    return s.start <= f.to && (s.end ?? payload.now) >= f.from;
  };

  const rows = [];
  let y = 0;
  for (const g of payload.projects) {
    if (!wants(f.projects, g.project)) continue;
    const groupRows = [];
    for (const t of g.trees) {
      if (!wants(f.roots, t.rootId)) continue;
      const kept = t.rows.filter((r) => r.context || overlaps(r.id));
      if (!kept.some((r) => !r.context)) continue;
      for (const r of kept) groupRows.push({ kind: 'row', id: r.id, depth: r.depth, context: r.context, project: g.project, rootId: t.rootId });
    }
    if (!groupRows.length) continue;
    rows.push({ kind: 'project', key: `p:${g.project}`, project: g.project, y });
    y += HEADER_H;
    for (const r of groupRows) {
      rows.push({ ...r, key: `r:${g.project}:${r.rootId}:${r.id}`, y });
      y += ROW_H;
    }
  }

  const rowsOf = new Map();
  for (const r of rows) if (r.kind === 'row') (rowsOf.get(r.id) ?? rowsOf.set(r.id, []).get(r.id)).push(r);

  const links = [];
  payload.links.forEach((l, i) => {
    const visible = l.type === 'wake' && l.heartbeat ? f.heartbeat : f.linkTypes.has(l.type);
    if (!visible || l.ts < f.from || l.ts > f.to) return;
    const a = rowsOf.get(l.from);
    const b = rowsOf.get(l.to);
    if (!a || !b) return;
    const shared = a.find((ra) => b.some((rb) => rb.project === ra.project));
    const ra = shared ?? a[0];
    const rb = shared ? b.find((x) => x.project === shared.project) : b[0];
    links.push({ ...l, key: `l:${i}`, y1: ra.y + ROW_H / 2, y2: rb.y + ROW_H / 2 });
  });

  return { rows, links, height: y };
}
