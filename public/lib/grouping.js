// Pure row grouping: payload trees + sessions + selection → ordered rows (no `y`).
// Order: project → conductor → section lead → worker. A project's band holds, per tree, the conductor
// header, then its section-lead headers and the workers of that project at their tree depth.

/** Label for the conductor project's band and menu item. */
export const CONDUCTOR_LABEL = 'Conductor';

// The path of an entry, outermost first: its project, then its owner chain ([conductor] or [conductor, lead]).
const LEVELS = ['project', 'owner'];

const wants = (set, v) => !set || set.has(v);

export const projectLabel = (project, conductorProject) => (project === conductorProject ? CONDUCTOR_LABEL : project);

/** Project names sorted by name, the conductor project first. */
export const sortProjects = (projects, conductorProject) =>
  [...projects].sort((a, b) => (a === conductorProject ? -1 : b === conductorProject ? 1 : a < b ? -1 : a > b ? 1 : 0));

const overlapsAt = (s, from, to, now) => s.start <= to && (s.end ?? now) >= from;

/** rootId → Set of projects of the tree's non-root rows that overlap the payload window, plus a lead's own project while a worker below it overlaps (the bands `groupRows` emits). */
export function treeProjects(payload) {
  const { from, to } = payload.window;
  const out = new Map();
  for (const t of payload.trees) {
    const set = new Set();
    let lead = null; // the depth-1 lead whose subtree the current row is in
    for (const r of t.rows) {
      const s = payload.sessions[r.id];
      if (r.depth === 1) lead = r.role === 'lead' ? s : null;
      if (r.depth > 0 && s.project && overlapsAt(s, from, to, payload.now)) {
        set.add(s.project);
        if (r.depth > 1 && lead?.project) set.add(lead.project);
      }
    }
    out.set(t.rootId, set);
  }
  return out;
}

/**
 * Entries of one tree: a unit per (owner, project) holding the owner's workers in that project plus
 * their ancestors below the owner, and a self-entry per section lead in its own project.
 * `sel`: { roots, projects, from, to, now, conductorProject } (null set = all).
 */
function entriesOf(tree, base, sessions, sel) {
  const { rows } = tree;
  const overlaps = (id) => overlapsAt(sessions[id], sel.from, sel.to, sel.now);
  const entries = [];
  const units = new Map(); // `${ownerIdx}\0${project}` → entry
  const keptIn = new Map(); // entry → Set of row indices
  const leads = new Map(); // index → lead row
  const stack = []; // indices of the current ancestor chain
  rows.forEach((row, i) => {
    stack.length = row.depth;
    stack.push(i);
    if (row.role === 'lead') { leads.set(i, row); return; }
    const project = sessions[row.id].project;
    if (row.role !== 'worker' || !project || !wants(sel.projects, project) || !overlaps(row.id)) return;
    const owner = rows[stack[1]]?.role === 'lead' ? stack[1] : 0;
    const key = `${owner}\0${project}`;
    let entry = units.get(key);
    if (!entry) {
      entry = { project, chain: owner === 0 ? [0] : [0, owner], unit: [] };
      units.set(key, entry);
      keptIn.set(entry, new Set());
      entries.push(entry);
    }
    const kept = keptIn.get(entry);
    // ancestors strictly below the owner; stop at one already kept: amortised O(n)
    for (let d = row.depth; d > rows[owner].depth && !kept.has(stack[d]); d--) kept.add(stack[d]);
  });
  // A lead keeps its own-project entry while it overlaps or has a kept worker below it.
  const driven = new Set([...keptIn.keys()].map((e) => e.chain[1]).filter((i) => i !== undefined));
  for (const [i, row] of leads) {
    const project = sessions[row.id].project;
    if (wants(sel.projects, project) && (overlaps(row.id) || driven.has(i))) entries.push({ project, chain: [0, i], unit: [] });
  }
  for (const [entry, kept] of keptIn) {
    entry.unit = [...kept].sort((a, b) => a - b).map((i) => ({ i, id: rows[i].id, depth: rows[i].depth, order: base + i }));
  }
  return entries.map((e) => ({ ...e, chain: e.chain.map((i) => ({ i, id: rows[i].id, depth: rows[i].depth, role: rows[i].role, order: base + i })) }));
}

/** Inserts an entry into the trie of its path. */
function insert(trie, entry, rootId) {
  const path = LEVELS.flatMap((level) => (level === 'project' ? [{ project: entry.project }] : entry.chain));
  let node = trie.get(entry.project) ?? trie.set(entry.project, { children: new Map(), unit: [] }).get(entry.project);
  const names = [entry.project];
  for (const step of path.slice(1)) {
    names.push(step.id);
    if (!node.children.has(step.id)) node.children.set(step.id, { ...step, children: new Map(), unit: [], names: [...names], rootId });
    node = node.children.get(step.id);
  }
  node.unit.push(...entry.unit);
}

export function groupRows(trees, sessions, sel) {
  const trie = new Map();
  let base = 0;
  for (const tree of trees) {
    if (wants(sel.roots, tree.rootId)) {
      for (const entry of entriesOf(tree, base, sessions, sel)) insert(trie, entry, tree.rootId);
    }
    base += tree.rows.length;
  }

  const out = [];
  const emitNode = (node, project) => {
    const s = sessions[node.id];
    out.push({
      kind: 'row', key: `r:${node.names.join('/')}`, id: node.id, depth: node.depth,
      context: node.role === 'conductor' || s.project !== project, head: node.role, group: project, rootId: node.rootId,
    });
    const items = [
      ...[...node.children.values()].map((n) => ({ order: n.order, node: n })),
      ...node.unit.map((u) => ({ order: u.order, unit: u })),
    ].sort((a, b) => a.order - b.order);
    for (const it of items) {
      if (it.node) { emitNode(it.node, project); continue; }
      const u = it.unit;
      out.push({
        kind: 'row', key: `r:${node.names.join('/')}/${u.id}`, id: u.id, depth: u.depth,
        context: sessions[u.id].project !== project, group: project, rootId: node.rootId,
      });
    }
  };
  for (const project of sortProjects(trie.keys(), sel.conductorProject)) {
    out.push({ kind: 'band', key: `p:${project}`, project, label: projectLabel(project, sel.conductorProject) });
    const roots = [...trie.get(project).children.values()].sort((a, b) => a.order - b.order);
    for (const r of roots) emitNode(r, project);
  }
  return out;
}
