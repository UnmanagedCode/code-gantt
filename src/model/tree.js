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

  // Cycle detection in O(n): colour 1 = on the current path, 2 = finished.
  let loops = 0;
  const colour = new Map();
  for (const start of byId.keys()) {
    if (colour.has(start)) continue;
    const path = [];
    let cur = start;
    while (cur && parentOf.has(cur) && !colour.has(cur)) {
      colour.set(cur, 1);
      path.push(cur);
      cur = parentOf.get(cur);
    }
    if (cur && colour.get(cur) === 1) {
      const cycle = path.slice(path.indexOf(cur));
      parentOf.delete([...cycle].sort()[0]);
      loops++;
    }
    for (const id of path) colour.set(id, 2);
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
    const stack = [[id, 0]]; // iterative: a very deep chain must not overflow the call stack
    while (stack.length) {
      const [cur, depth] = stack.pop();
      rows.push({ id: cur, depth, project: byId.get(cur).project });
      const list = kids.get(cur) ?? [];
      for (let i = list.length - 1; i >= 0; i--) stack.push([list[i], depth + 1]);
    }
    trees.push({ rootId: id, orphan: Boolean(rec.parent), rows, start: startOf(rec) });
  }
  trees.sort((a, b) => a.start - b.start || (a.rootId < b.rootId ? -1 : 1));
  return { trees, loops };
}

/**
 * Groups trees project → tree. A tree's projects are the projects of its descendants; the root
 * only ever appears as a context ancestor. For project P a tree contributes every descendant with
 * project P plus all their ancestors; ancestors (and the root) outside P are `context: true`.
 */
export function groupByProject(trees) {
  const groups = new Map();
  for (const t of trees) {
    const projects = new Set(t.rows.filter((r) => r.depth > 0).map((r) => r.project).filter(Boolean));
    for (const project of projects) {
      const keep = new Set();
      const stack = [];
      for (const row of t.rows) {
        stack.length = row.depth;
        stack.push(row.id);
        if (row.depth > 0 && row.project === project) {
          // walk up only until an ancestor already kept: amortised O(n)
          for (let i = row.depth; i >= 0 && !keep.has(stack[i]); i--) keep.add(stack[i]);
        }
      }
      const rows = t.rows
        .filter((r) => keep.has(r.id))
        .map((r) => ({ id: r.id, depth: r.depth, context: r.depth === 0 || r.project !== project }));
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project).push({ rootId: t.rootId, orphan: t.orphan, rows });
    }
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([project, ts]) => ({ project, trees: ts }));
}
