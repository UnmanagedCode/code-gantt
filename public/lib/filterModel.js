// Pure adapter between `state.filters` (the only store) and the per-dimension key sets the filter UI works with.
// Dimension ids: 'projects' | 'roots' | 'links'.
import { labelOf } from './format.js';

/** Pseudo-item for heartbeat wakes in the links dimension (not a link type). */
export const HEARTBEAT_KEY = 'heartbeat';

export function dimensionItems(payload) {
  const roots = [...new Set(payload.projects.flatMap((g) => g.trees.map((t) => t.rootId)))];
  return {
    projects: payload.projects.map((g) => ({ key: g.project, label: g.project })),
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
