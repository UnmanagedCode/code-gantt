import { el, clear, listen, unlisten } from '../lib/dom.js';
import { matches, selectAll, selectNone, only, toggle, triState, toggleGroup, summary } from '../lib/selection.js';
import { groupLinkItems } from '../lib/linkGroups.js';
import { HEARTBEAT_KEY } from '../lib/filterModel.js';
import { swatch } from './swatch.js';

const setHidden = (node, hidden) => { if (hidden) node.setAttribute('hidden', ''); else node.removeAttribute('hidden'); };

/**
 * One dropdown popover over a list of {key,label} items. The DOM is built once and updated in place,
 * so a render (checkbox toggle, live reload) neither closes it nor loses focus.
 * Holds no selection of its own: `update(items, selected)` pushes it in, `onSelect(nextSet)` writes it out.
 */
export function createFilterMenu({ dim, label, namePrefix, grouped, onSelect, onOpen }) {
  let items = [];
  let selected = new Set();
  let query = '';
  let open = false;
  let signature = '';
  let checks = []; // [{ input, key }]
  let groupChecks = []; // [{ input, keys }]
  const expanded = new Set();

  const popId = `fmenu-${dim}`;
  const summaryText = el('span', { class: 'fmenu-summary' });
  const button = el('button', { type: 'button', class: 'fmenu-btn', name: `filter:${dim}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': popId },
    summaryText, el('span', { 'aria-hidden': 'true' }, ' ▾'));
  const search = el('input', { type: 'search', class: 'fmenu-search', name: `search:${dim}`, 'aria-label': `Search ${label.toLowerCase()}`, placeholder: 'Filter…', autocomplete: 'off' });
  const allBtn = el('button', { type: 'button', name: 'all' }, 'All');
  const noneBtn = el('button', { type: 'button', name: 'none' }, 'None');
  const empty = el('p', { class: 'fmenu-empty hint', role: 'status' });
  const list = el('div', { class: 'fmenu-list' });
  const pop = el('div', { class: 'fmenu-pop', id: popId, role: 'dialog', 'aria-label': `${label} filter`, hidden: true },
    search, el('div', { class: 'fmenu-actions' }, allBtn, noneBtn), empty, list);
  const root = el('div', { class: 'fmenu' }, button, pop);

  const inputName = (key) => (dim === 'links' && key === HEARTBEAT_KEY ? 'heartbeat' : `${namePrefix}:${key}`);

  /** Items visible under the search query; grouped menus return [{id,label,items}] groups. */
  function visible() {
    if (!grouped) return [{ id: null, label: null, items: items.filter((i) => matches(i.label, query)) }].filter((g) => g.items.length);
    return groupLinkItems(items)
      .map((g) => ({ ...g, items: matches(g.label, query) ? g.items : g.items.filter((i) => matches(i.label, query)) }))
      .filter((g) => g.items.length);
  }
  const visibleKeys = () => visible().flatMap((g) => g.items.map((i) => i.key));

  function row(item) {
    const input = el('input', { type: 'checkbox', name: inputName(item.key), 'data-focus-id': `check:${item.key}` });
    listen(input, 'change', () => onSelect(toggle(selected, item.key, input.checked)));
    checks.push({ input, key: item.key });
    const onlyBtn = el('button', { type: 'button', class: 'only', name: 'only', 'aria-label': `Only ${item.label}`, 'data-focus-id': `only:${item.key}` }, 'only');
    listen(onlyBtn, 'click', () => onSelect(only(item.key)));
    return el('div', { class: 'fmenu-row', 'data-key': item.key },
      el('label', { class: 'check' }, input, dim === 'links' ? swatch(item.key) : null, item.label), onlyBtn);
  }

  function group(g) {
    const isOpen = expanded.has(g.id) || query.trim() !== '';
    const bodyId = `fmenu-${dim}-g-${g.id}`;
    const keys = g.items.map((i) => i.key);
    const gInput = el('input', { type: 'checkbox', name: `group:${g.id}`, 'data-focus-id': `group:${g.id}`, 'data-group-check': g.id });
    listen(gInput, 'change', () => onSelect(toggleGroup(selected, keys)));
    groupChecks.push({ input: gInput, keys, count: null });
    const count = el('span', { class: 'count' });
    groupChecks.at(-1).count = count;
    const disclose = el('button', { type: 'button', class: 'disclose', 'aria-expanded': String(isOpen), 'aria-controls': bodyId, 'aria-label': `${isOpen ? 'Collapse' : 'Expand'} ${g.label}`, 'data-focus-id': `disclose:${g.id}`, disabled: query.trim() !== '' }, isOpen ? '▾' : '▸');
    listen(disclose, 'click', () => { toggleExpanded(g.id, !isOpen); });
    return el('div', { class: 'fmenu-group', 'data-group': g.id },
      el('div', { class: 'fmenu-group-head' }, disclose, el('label', { class: 'check' }, gInput, g.label, count)),
      el('div', { id: bodyId, role: 'group', 'aria-label': g.label, hidden: !isOpen }, g.items.map(row)));
  }

  function toggleExpanded(id, on) {
    if (on) expanded.add(id); else expanded.delete(id);
    renderList();
    syncChecks();
  }

  function renderList() {
    const sig = JSON.stringify([items, query, [...expanded]]);
    if (sig === signature) return;
    signature = sig;
    const active = document.activeElement;
    const focusId = active && list.contains(active) ? active.getAttribute('data-focus-id') : null;
    clear(list);
    checks = [];
    groupChecks = [];
    const vis = visible();
    list.append(...vis.map((g) => (grouped ? group(g) : g.items.map(row))).flat());
    empty.textContent = vis.length === 0 && query.trim() !== '' ? 'No matches' : '';
    if (focusId) [...list.querySelectorAll('[data-focus-id]')].find((n) => n.getAttribute('data-focus-id') === focusId)?.focus();
  }

  function syncChecks() {
    for (const c of checks) c.input.checked = selected.has(c.key);
    for (const g of groupChecks) {
      const state = triState(selected, g.keys);
      g.input.checked = state === 'all';
      g.input.indeterminate = state === 'some';
      g.count.textContent = `${g.keys.filter((k) => selected.has(k)).length}/${g.keys.length}`;
    }
  }

  function update(nextItems, nextSelected, all) {
    items = nextItems;
    selected = nextSelected;
    summaryText.textContent = summary(label, items.filter((i) => selected.has(i.key)).length, items.length, all);
    renderList();
    syncChecks();
  }

  function onDocMouseDown(e) { if (!root.contains(e.target)) close({ focusButton: false }); }

  function openMenu() {
    if (open) return;
    open = true;
    onOpen?.();
    button.setAttribute('aria-expanded', 'true');
    setHidden(pop, false);
    listen(document, 'mousedown', onDocMouseDown);
    search.focus();
  }

  function close({ focusButton = false } = {}) {
    if (!open) return;
    open = false;
    unlisten(document, 'mousedown', onDocMouseDown);
    button.setAttribute('aria-expanded', 'false');
    setHidden(pop, true);
    search.value = '';
    query = '';
    renderList();
    syncChecks();
    if (focusButton) button.focus();
  }

  const navigable = () => [...list.querySelectorAll('input[type="checkbox"]')].filter((i) => !i.closest('[hidden]'));

  listen(button, 'click', () => (open ? close({ focusButton: false }) : openMenu()));
  listen(search, 'input', () => { query = search.value; renderList(); syncChecks(); });
  listen(allBtn, 'click', () => onSelect(selectAll(selected, visibleKeys())));
  listen(noneBtn, 'click', () => onSelect(selectNone(selected, visibleKeys())));
  listen(root, 'keydown', (e) => {
    if (e.key === 'Escape' && open) { e.preventDefault(); close({ focusButton: true }); return; }
    if (e.target === button && e.key === 'ArrowDown') { e.preventDefault(); openMenu(); return; }
    if (!open) return;
    const t = e.target;
    const ctls = navigable();
    if (e.key === 'ArrowDown' && t === search) { e.preventDefault(); ctls[0]?.focus(); return; }
    const i = ctls.indexOf(t);
    if (i < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); (ctls[i + 1] ?? t).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (i === 0 ? search : ctls[i - 1]).focus(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && t.hasAttribute('data-group-check') && query.trim() === '') {
      e.preventDefault();
      toggleExpanded(t.getAttribute('data-group-check'), e.key === 'ArrowRight');
    }
  });
  listen(root, 'focusout', (e) => { if (e.relatedTarget && !root.contains(e.relatedTarget)) close({ focusButton: false }); });

  return { root, update, open: openMenu, close, isOpen: () => open };
}
