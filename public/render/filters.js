import { el, clear, listen } from '../lib/dom.js';
import { labelOf } from '../lib/format.js';

export const RANGES = [
  ['6 hours', 6 * 3600_000], ['24 hours', 24 * 3600_000], ['72 hours', 72 * 3600_000], ['7 days', 7 * 86400_000], ['14 days', 14 * 86400_000],
];

function checkbox(name, label, checked, onChange, swatchType) {
  const input = el('input', { type: 'checkbox', name, checked });
  listen(input, 'change', () => onChange(input.checked));
  return el('label', { class: 'check' }, input, swatchType ? el('span', { class: 'swatch', 'data-type': swatchType }) : null, label);
}

/** Toolbar: range, project, tree and link-type filters. Mutates `filters`, then calls h.onChange(). */
export function renderFilters(host, payload, filters, rangeMs, h) {
  clear(host);
  const projects = payload.projects.map((g) => g.project);
  const roots = [...new Set(payload.projects.flatMap((g) => g.trees.map((t) => t.rootId)))];
  const toggle = (set, all, v, on) => {
    const next = new Set(set ?? all);
    if (on) next.add(v); else next.delete(v);
    return next.size === all.length ? null : next;
  };

  const range = el('select', { name: 'range', 'aria-label': 'Date range' },
    RANGES.map(([label, ms]) => el('option', { value: ms, selected: ms === rangeMs }, `Last ${label}`)));
  listen(range, 'change', () => h.onRange(Number(range.value)));

  host.appendChild(el('div', { class: 'filter-row' },
    el('label', null, 'Range ', range),
    el('button', { type: 'button', name: 'reset-zoom' }, 'Reset zoom'),
  ));
  const reset = host.querySelector('button[name="reset-zoom"]');
  listen(reset, 'click', () => h.onResetZoom());

  host.appendChild(el('fieldset', null, el('legend', null, 'Projects'),
    projects.map((p) => checkbox(`project:${p}`, p, !filters.projects || filters.projects.has(p), (on) => { filters.projects = toggle(filters.projects, projects, p, on); h.onChange(); }))));
  host.appendChild(el('fieldset', null, el('legend', null, 'Trees'),
    roots.map((r) => checkbox(`root:${r}`, labelOf(payload.sessions[r]), !filters.roots || filters.roots.has(r), (on) => { filters.roots = toggle(filters.roots, roots, r, on); h.onChange(); }))));
  host.appendChild(el('fieldset', null, el('legend', null, 'Links'),
    payload.linkTypes.map((t) => checkbox(`link:${t}`, t, filters.linkTypes.has(t), (on) => { if (on) filters.linkTypes.add(t); else filters.linkTypes.delete(t); h.onChange(); }, t)),
    checkbox('heartbeat', 'wake heartbeat', filters.heartbeat, (on) => { filters.heartbeat = on; h.onChange(); }, 'heartbeat')));
}
