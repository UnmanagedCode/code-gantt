import { el, listen } from '../lib/dom.js';
import { dimensionItems, selectedKeys, applySelection } from '../lib/filterModel.js';
import { createFilterMenu } from './filterMenu.js';

export const RANGES = [
  ['6 hours', 6 * 3600_000], ['24 hours', 24 * 3600_000], ['72 hours', 72 * 3600_000], ['7 days', 7 * 86400_000], ['14 days', 14 * 86400_000],
];

const MENUS = [
  { dim: 'projects', label: 'Projects', namePrefix: 'project' },
  { dim: 'roots', label: 'Trees', namePrefix: 'root' },
  { dim: 'links', label: 'Links', namePrefix: 'link', grouped: true },
];

/**
 * Toolbar built once: range, the Projects/Trees/Links popovers, reset zoom.
 * `update` pushes the current payload and filters in; a menu's selection is written back through filterModel.
 */
export function createFilterBar(host, h) {
  let filters = null;
  let items = null;
  const menus = new Map();
  const closeOthers = (dim) => { for (const [d, m] of menus) if (d !== dim) m.close({ focusButton: false }); };
  for (const spec of MENUS) {
    menus.set(spec.dim, createFilterMenu({
      ...spec,
      onSelect: (set) => { applySelection(filters, spec.dim, items[spec.dim], set); h.onChange(); },
      onOpen: () => closeOthers(spec.dim),
    }));
  }

  const range = el('select', { name: 'range', 'aria-label': 'Date range' },
    RANGES.map(([label, ms]) => el('option', { value: ms }, `Last ${label}`)));
  listen(range, 'change', () => h.onRange(Number(range.value)));
  const reset = el('button', { type: 'button', name: 'reset-zoom' }, 'Reset zoom');
  listen(reset, 'click', () => h.onResetZoom());
  host.appendChild(el('div', { class: 'filter-row' },
    el('label', null, 'Range ', range), ...[...menus.values()].map((m) => m.root), reset));

  return {
    update(payload, nextFilters, rangeMs) {
      filters = nextFilters;
      items = dimensionItems(payload);
      range.value = String(rangeMs);
      for (const [dim, menu] of menus) menu.update(items[dim], selectedKeys(filters, dim, items[dim]));
    },
  };
}
