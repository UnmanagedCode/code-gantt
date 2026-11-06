const startOf = (rec) => Date.parse(rec.segments?.[0]?.at) || 0;

/**
 * Builds conducted trees from the session map.
 * Roots: no `parent`, or a parent absent from the map (orphan). A parent loop is broken at
 * its smallest id (that member becomes an orphan root) and counted.
 * Childless roots are not trees.
 * @param {Map<string, any>} byId
 */
export function buildForest(byId) {
  const parentOf = new Map();
  for (const [id, rec] of byId) if (rec.parent && byId.has(rec.parent)) parentOf.set(id, rec.parent);

  let loops = 0;
  const seenInLoop = new Set();
  for (const id of byId.keys()) {
    const path = [];
    const on = new Set();
    let cur = id;
    while (cur && parentOf.has(cur) && !on.has(cur) && !seenInLoop.has(cur)) {
      on.add(cur);
      path.push(cur);
      cur = parentOf.get(cur);
    }
    if (cur && on.has(cur)) {
      const cycle = path.slice(path.indexOf(cur));
      cycle.forEach((c) => seenInLoop.add(c));
      parentOf.delete([...cycle].sort()[0]);
      loops++;
    }
  }

  const kids = new Map();
  for (const [id, p] of parentOf) {
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(id);
  }
  for (const list of kids.values()) list.sort((a, b) => startOf(byId.get(a)) - startOf(byId.get(b)) || (a < b ? -1 : 1));

  const trees = [];
  for (const [id, rec] of byId) {
    if (parentOf.has(id)) continue;
    if (!kids.has(id)) continue;
    const rows = [];
    const walk = (cur, depth) => {
      rows.push({ id: cur, depth, project: byId.get(cur).project });
      for (const k of kids.get(cur) ?? []) walk(k, depth + 1);
    };
    walk(id, 0);
    trees.push({ rootId: id, orphan: Boolean(rec.parent), rows, start: startOf(rec) });
  }
  trees.sort((a, b) => a.start - b.start || (a.rootId < b.rootId ? -1 : 1));
  return { trees, loops };
}

/**
 * Groups trees project → tree. For project P a tree contributes every session with project P plus
 * all their ancestors up to the root; ancestors that are not in P get `context: true`.
 * A tree whose sessions carry no project (a root alone) yields no group.
 */
export function groupByProject(trees) {
  const groups = new Map();
  for (const t of trees) {
    const projects = new Set(t.rows.map((r) => r.project).filter(Boolean));
    for (const project of projects) {
      const keep = new Set();
      const stack = [];
      for (const row of t.rows) {
        stack.length = row.depth;
        stack.push(row.id);
        if (row.project === project) stack.forEach((id) => keep.add(id));
      }
      const rows = t.rows
        .filter((r) => keep.has(r.id))
        .map((r) => ({ id: r.id, depth: r.depth, context: r.project !== project }));
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project).push({ rootId: t.rootId, orphan: t.orphan, rows });
    }
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([project, ts]) => ({ project, trees: ts }));
}
