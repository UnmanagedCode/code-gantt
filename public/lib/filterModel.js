// Pure adapter between `state.filters` (the only store) and the per-dimension key sets the filter UI works with.
// Dimension ids: 'projects' | 'roots' | 'links'. The 'roots' dimension is the Conductors filter (a tree is keyed by its root, the conductor).
import { labelOf } from './format.js';
import { treeProjects, sortProjects, projectLabel } from './grouping.js';

/** Pseudo-item for heartbeat wakes in the links dimension (not a link type). */
export const HEARTBEAT_KEY = 'heartbeat';

export function dimensionItems(payload) {
  const roots = payload.trees.map((t) => t.rootId);
  const projects = sortProjects(new Set([...treeProjects(payload).values()].flatMap((set) => [...set])), payload.conductorProject);
  return {
    projects: projects.map((p) => ({ key: p, label: projectLabel(p, payload.conductorProject) })),
    roots: roots.map((r) => ({ key: r, label: labelOf(payload.sessions[r]) })),
    links: [...payload.linkTypes.map((t) => ({ key: t, label: t })), { key: HEARTBEAT_KEY, label: 'wake heartbeat' }],
  };
}

/** Concrete selected key set; for projects/roots `null` means every current item. */
export function selectedKeys(filters, dim, items) {
  if (dim === 'links') return new Set([...filters.linkTypes, ...(filters.heartbeat ? [HEARTBEAT_KEY] : [])]);
  return new Set(filters[dim] ?? items.map((i) => i.key));
}

/** True when the stored selection means All: `null` for projects/roots, every item selected for links. */
export function isAll(filters, dim, items) {
  if (dim === 'links') return items.every((i) => selectedKeys(filters, dim, items).has(i.key));
  return filters[dim] == null;
}

/** Writes `set` into `filters`. Covering every current item collapses projects/roots back to null (All). */
export function applySelection(filters, dim, items, set) {
  if (dim === 'links') {
    filters.linkTypes = new Set([...set].filter((k) => k !== HEARTBEAT_KEY));
    filters.heartbeat = set.has(HEARTBEAT_KEY);
    return;
  }
  filters[dim] = items.every((i) => set.has(i.key)) ? null : new Set(set);
}

/** Projects the Projects menu lists: all of them under Conductors All, else those with a tree whose root is selected. */
export function listedProjects(payload, filters, projectItems) {
  if (filters.roots == null) return projectItems;
  const touched = new Set();
  for (const [rootId, set] of treeProjects(payload)) if (filters.roots.has(rootId)) for (const p of set) touched.add(p);
  return projectItems.filter((i) => touched.has(i.key));
}

/** Text for the chart's empty state, naming the filter that left nothing to draw. */
export function emptyHint(payload, filters) {
  const items = dimensionItems(payload);
  const roots = selectedKeys(filters, 'roots', items.roots);
  if (!items.roots.some((i) => roots.has(i.key))) return 'No conductors selected.';
  const projects = selectedKeys(filters, 'projects', items.projects);
  if (!listedProjects(payload, filters, items.projects).some((i) => projects.has(i.key))) return 'No projects selected.';
  return 'Nothing to draw for this selection.';
}
