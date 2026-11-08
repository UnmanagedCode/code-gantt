/** The project whose depth-1 sessions are section leads (the conductor's own workers that drive other projects). */
export const CONDUCTOR_PROJECT = '.conduct';

const startOf = (rec) => Date.parse(rec.segments?.[0]?.at) || 0;

/**
 * Builds conducted trees from the session map.
 * Roots: no `parent`, or a parent absent from the map (orphan). A parent loop is broken at
 * its smallest id (that member becomes an orphan root) and counted.
 * Childless roots are not trees.
 * Each row carries a `role`: the root is the `conductor`; a depth-1 session in CONDUCTOR_PROJECT is a
 * section `lead`; everything else is a `worker` (a CONDUCTOR_PROJECT session deeper down included).
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
      const role = depth === 0 ? 'conductor' : depth === 1 && byId.get(cur).project === CONDUCTOR_PROJECT ? 'lead' : 'worker';
      rows.push({ id: cur, depth, role });
      const list = kids.get(cur) ?? [];
      for (let i = list.length - 1; i >= 0; i--) stack.push([list[i], depth + 1]);
    }
    trees.push({ rootId: id, orphan: Boolean(rec.parent), rows, start: startOf(rec) });
  }
  trees.sort((a, b) => a.start - b.start || (a.rootId < b.rootId ? -1 : 1));
  return { trees, loops };
}
