import { el, clear, listen } from '../lib/dom.js';
import { dimensionItems, selectedKeys, applySelection } from '../lib/filterModel.js';
import { groupLinkItems } from '../lib/linkGroups.js';
import { toggle } from '../lib/selection.js';
import { swatch } from './swatch.js';

/** Compact clickable legend of the link types, in the Links popover's order. Reads and writes the same filters. */
export function createLegend(host, { onChange }) {
  let filters = null;
  let items = [];
  let keySig = '';
  const root = el('div', { class: 'legend', role: 'group', 'aria-label': 'Link types' });
  host.appendChild(root);

  return {
    update(payload, nextFilters) {
      filters = nextFilters;
      items = dimensionItems(payload).links;
      const ordered = groupLinkItems(items).flatMap((g) => g.items);
      const sig = JSON.stringify(ordered);
      if (sig !== keySig) {
        keySig = sig;
        clear(root);
        for (const item of ordered) {
          const b = el('button', { type: 'button', class: 'legend-item', 'data-key': item.key, 'aria-pressed': 'true' }, swatch(item.key), item.label);
          listen(b, 'click', () => {
            const on = b.getAttribute('aria-pressed') !== 'true';
            applySelection(filters, 'links', items, toggle(selectedKeys(filters, 'links', items), item.key, on));
            onChange();
          });
          root.appendChild(b);
        }
      }
      const selected = selectedKeys(filters, 'links', items);
      for (const b of root.children) b.setAttribute('aria-pressed', String(selected.has(b.getAttribute('data-key'))));
    },
  };
}
