import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { PROMPT_SENTINEL as S } from '../helpers/sentinel.mjs';

const win = new Window({ url: 'http://localhost/', width: 1200, height: 800 });
for (const k of ['document', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent']) globalThis[k] = win[k];
globalThis.window = win;

const { el, svgEl } = await import('../../public/lib/dom.js');
const { mount } = await import('../../public/app.js');
const { LABEL_W, PAIR_OFFSET_PX } = await import('../../public/render/chart.js');
const { brushView, timeScale, readout } = await import('../../public/lib/scale.js');

const EVIL = '<img src=x onerror=alert(1)>';
const EVIL2 = '"><script>x</script>';

function payload(over = {}) {
  const s = (id, extra) => ({ id, start: 1000, end: 9000, endKind: 'exited', turns: [[2000, 3000]], turnCount: 4, rotations: [{ at: 5000, reason: 'renew' }], stages: [{ stage: 'plan', from: 1000, to: 5000 }, { stage: 'implement', from: 5000, to: 9000, via: 'approve_plan' }], marks: [], ...extra });
  return {
    now: 10_000, window: { from: 0, to: 10_000 }, version: 1,
    linkTypes: ['spawn', 'send_prompt', 'forward', 'wake', 'other'],
    conductorProject: '.conduct',
    trees: [{ rootId: 'root', rows: [{ id: 'root', depth: 0, role: 'conductor', note: S }, { id: 'w1', depth: 1, role: 'worker' }, { id: 'w2', depth: 1, role: 'worker' }] }],
    sessions: {
      root: s('root', { title: 'Conductor' }),
      w1: s('w1', { title: 'Worker one', project: 'proj', worktree: 'wt-1', model: 'model-x', playbook: 'classic', prompt: S, text: S, feedback: [S] }),
      w2: s('w2', { title: 'Worker two', project: 'proj', endKind: 'approx', end: 9500 }),
    },
    links: [
      { ts: 1500, type: 'spawn', from: 'root', to: 'w1', body: S, text: S },
      { ts: 6000, type: 'wake', from: 'w1', to: 'root' },
      { ts: 6500, type: 'wake', from: 'w2', to: 'root', heartbeat: true },
    ],
    diagnostics: { liveness: 'unavailable', horizon: '1970-01-01T00:00:00.000Z', unresolved: 0, unmatchedStoreRows: { events: 0 }, unknownTools: {}, unknownKinds: {}, corruptLines: 0, missing: [], errors: [] },
    ...over,
  };
}

function boot(p) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = mount(root, { getJson: async () => p, subscribe: null });
  return { root, app };
}
const click = (node) => node.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

test('dom.js refuses event-handler, style and URL attributes', () => {
  for (const a of ['onclick', 'onerror', 'style', 'href', 'src', 'srcdoc', 'xlink:href']) {
    assert.throws(() => el('div', { [a]: 'x' }), /not allowed/, a);
    assert.throws(() => svgEl('rect', { [a]: 'x' }), /not allowed/, a);
  }
  assert.throws(() => el('script'), /not allowed/);
});

test('XSS: hostile id, title, project, worktree, model, stage, via and tool render as text only', async () => {
  const p = payload();
  p.sessions[EVIL] = { ...p.sessions.w2, id: EVIL, endKind: 'exited', title: undefined };
  p.trees[0].rows.push({ id: EVIL, depth: 1, role: 'worker' });
  p.links.push({ ts: 8000, type: 'spawn', from: 'root', to: EVIL });
  p.sessions.w2.project = EVIL;
  p.sessions[EVIL].project = EVIL;
  p.sessions.w1 = { ...p.sessions.w1, id: 'w1', title: EVIL2, project: EVIL, worktree: EVIL, model: EVIL2, playbook: EVIL,
    stages: [{ stage: EVIL, from: 1000, to: 9000, via: EVIL2 }] };
  p.linkTypes.push(EVIL);
  p.links.push({ ts: 7000, type: EVIL, from: 'root', to: 'w1' });
  const evilPair = { sender: 'root', source: EVIL };
  p.links.push({ ts: 7200, type: 'send_prompt', from: 'root', to: 'w2', pair: evilPair }, { ts: 7200, type: 'forward', from: EVIL, to: 'w2', pair: evilPair });
  const { root, app } = boot(p);
  await app.load();
  click(root.querySelector('[data-id="w1"]'));
  const w1Details = root.querySelector('#details').textContent;
  const evilBar = [...root.querySelectorAll('.bar-g')].find((n) => n.getAttribute('data-id') === EVIL);
  assert.ok(evilBar, 'a session whose id is hostile still renders a bar');
  click(evilBar);
  assert.ok(root.querySelector('#details').textContent.includes(EVIL));
  const g = root.querySelector('.link-g');
  g.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
  root.querySelector('.link-g[data-type="forward"]').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
  assert.ok(root.querySelector('g.tooltip').textContent.includes(`forwarding ${EVIL}`));
  for (const bad of ['img', 'script']) assert.equal(document.querySelectorAll(bad).length, 0, bad);
  assert.equal(document.querySelectorAll('[onerror],[onclick]').length, 0);
  assert.ok(w1Details.includes(EVIL));
  assert.ok(w1Details.includes(EVIL2));
  assert.ok(root.textContent.includes(EVIL));
});

test('an approx bar exposes "approximate end"; an exited bar does not', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const labelled = (id) => [...root.querySelectorAll(`[data-id="${id}"] [aria-label="approximate end"]`)];
  assert.equal(labelled('w2').length, 1);
  assert.equal(labelled('w1').length, 0);
});

test('clicking a bar opens details with id, project, worktree, model, playbook, stage history and turn count', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click(root.querySelector('[data-id="w1"]'));
  const d = root.querySelector('#details').textContent;
  for (const want of ['w1', 'proj', 'wt-1', 'model-x', 'classic', 'plan', 'implement', 'approve_plan', '4']) assert.ok(d.includes(want), want);
  click(root.querySelector('[data-id="w2"]'));
  assert.match(root.querySelector('#details').textContent, /approximate end/);
});

test('unchecking wake removes wake links from the DOM; the heartbeat toggle is separate', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const wakes = () => [...root.querySelectorAll('.link-g[data-type="wake"]')];
  assert.equal(wakes().length, 2);
  const box = root.querySelector('input[name="link:wake"]');
  box.checked = false;
  box.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.deepEqual(wakes().map((n) => n.classList.contains('heartbeat')), [true]);
  const hb = root.querySelector('input[name="heartbeat"]');
  hb.checked = false;
  hb.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.equal(wakes().length, 0);
});

test('a hovered link shows a tooltip naming type and endpoints', async () => {
  const { root, app } = boot(payload());
  await app.load();
  root.querySelector('.link-g[data-type="wake"]').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 50 }));
  const tip = root.querySelector('g.tooltip');
  assert.ok(tip);
  assert.match(tip.textContent, /wake/);
  assert.match(tip.textContent, /Worker one → Conductor/);
});

test('C6: free-text fields outside the payload schema are never rendered (page, tooltip, details)', async () => {
  const p = payload();
  const { root, app } = boot(p);
  await app.load();
  click(root.querySelector('[data-id="w1"]'));
  root.querySelector('.link-g').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 50 }));
  assert.ok(JSON.stringify(p).includes(S), 'fixture really carries the sentinel in unknown fields');
  assert.equal(document.body.textContent.includes(S), false);
  assert.equal(document.documentElement.outerHTML.includes(S), false);
  assert.match(root.querySelector('.diagnostics').textContent, /liveness: unavailable/);
});

test('R5: a selection named like an Object.prototype member that vanishes from the payload falls back to the hint, not garbage', async () => {
  const p = payload();
  p.sessions.constructor = { ...p.sessions.w2, id: 'constructor', endKind: 'exited' };
  p.trees[0].rows.push({ id: 'constructor', depth: 1, role: 'worker' });
  const { root, app } = boot(p);
  await app.load();
  click([...root.querySelectorAll('.bar-g')].find((n) => n.getAttribute('data-id') === 'constructor'));
  assert.ok(root.querySelector('#details').textContent.includes('constructor'));
  delete p.sessions.constructor;
  p.trees[0].rows.pop();
  await app.load();
  assert.match(root.querySelector('#details').textContent, /Select a bar/);
});

// U1: an empty chart is explained. Asserted on role/state (the status banner), not wording.
test('with horizon null the status banner is non-empty; with a horizon it is empty', async () => {
  const p = payload();
  const withHorizon = boot(p);
  await withHorizon.app.load();
  assert.equal(withHorizon.root.querySelector('.banner').textContent, '');
  const none = payload({ trees: [], sessions: {}, links: [] });
  none.diagnostics.horizon = null;
  const b = boot(none);
  await b.app.load();
  assert.notEqual(b.root.querySelector('.banner').textContent, '');
  // T5: keyed on the horizon, not on an empty chart
  const empty = boot(payload({ trees: [], sessions: {}, links: [] }));
  await empty.app.load();
  assert.equal(empty.root.querySelector('.banner').textContent, '');
});

// ---- filter popovers and legend ----
const two = () => {
  const p = payload();
  p.trees.push({ rootId: 'root2', rows: [{ id: 'root2', depth: 0, role: 'conductor' }, { id: 'x1', depth: 1, role: 'worker' }] });
  p.sessions.root2 = { ...p.sessions.root, id: 'root2', title: 'Second' };
  p.sessions.x1 = { ...p.sessions.w2, id: 'x1', project: 'other', endKind: 'exited', end: 9000 };
  return p;
};
const $ = (root, sel) => root.querySelector(sel);
const btn = (root, dim) => $(root, `button[name="filter:${dim}"]`);
const pop = (root, dim) => $(root, `#fmenu-${dim}`);
const isHidden = (n) => n.hasAttribute('hidden');
const summaryOf = (root, dim) => btn(root, dim).textContent.replace('▾', '').trim();
const setChecked = (input, on) => { input.checked = on; input.dispatchEvent(new win.Event('change', { bubbles: true })); };
const key = (node, k) => node.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
const wakeLinks = (root) => [...root.querySelectorAll('.link-g[data-type="wake"]')];
const bars = (root) => root.querySelectorAll('.bar-g').length;

test('summary buttons reflect the selection: All, None, n of m', async () => {
  const { root, app } = boot(two());
  await app.load();
  assert.equal(summaryOf(root, 'projects'), 'Projects · All');
  click($(root, '#fmenu-projects button[name="none"]'));
  assert.equal(summaryOf(root, 'projects'), 'Projects · None');
  click($(root, '#fmenu-projects .fmenu-row[data-key="proj"] button.only'));
  assert.equal(summaryOf(root, 'projects'), 'Projects · 1 of 2');
});

test('open focuses the search box; Escape closes and refocuses the button; mousedown outside closes', async () => {
  const { root, app } = boot(payload());
  await app.load();
  assert.equal(btn(root, 'links').getAttribute('aria-expanded'), 'false');
  assert.equal(isHidden(pop(root, 'links')), true);
  click(btn(root, 'links'));
  assert.equal(btn(root, 'links').getAttribute('aria-expanded'), 'true');
  assert.equal(isHidden(pop(root, 'links')), false);
  assert.equal(document.activeElement, $(root, 'input[name="search:links"]'));
  key($(root, 'input[name="search:links"]'), 'Escape');
  assert.equal(isHidden(pop(root, 'links')), true);
  assert.equal(document.activeElement, btn(root, 'links'));
  click(btn(root, 'links'));
  document.body.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(btn(root, 'links').getAttribute('aria-expanded'), 'false');
});

test('only one popover is open at a time', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click(btn(root, 'projects'));
  click(btn(root, 'roots'));
  assert.equal(isHidden(pop(root, 'projects')), true);
  assert.equal(isHidden(pop(root, 'roots')), false);
});

test('search hides non-matching rows; None with a search clears only the visible rows', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click(btn(root, 'links'));
  const search = $(root, 'input[name="search:links"]');
  search.value = 'wake';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal($(root, 'input[name="link:send_prompt"]'), null);
  assert.ok($(root, 'input[name="link:wake"]') && $(root, 'input[name="heartbeat"]'));
  click($(root, '#fmenu-links button[name="none"]'));
  assert.equal(wakeLinks(root).length, 0);
  search.value = '';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal($(root, 'input[name="link:spawn"]').checked, true);
  assert.equal($(root, 'input[name="link:wake"]').checked, false);
  assert.equal(root.querySelectorAll('.link-g[data-type="spawn"]').length, 1);
});

test('"only" on wake draws only the non-heartbeat wake links', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click($(root, '.fmenu-row[data-key="wake"] button.only'));
  assert.deepEqual(wakeLinks(root).map((n) => n.classList.contains('heartbeat')), [false]);
  assert.equal(root.querySelectorAll('.link-g:not([data-type="wake"])').length, 0);
});

test('group checkbox is tri-state: partial → all → none; disclose toggles expansion', async () => {
  const { root, app } = boot(payload());
  await app.load();
  setChecked($(root, 'input[name="link:wake"]'), false);
  const g = () => $(root, 'input[name="group:wakes"]');
  assert.equal(g().indeterminate, true);
  assert.equal(g().checked, false);
  click(g());
  assert.equal($(root, 'input[name="link:wake"]').checked, true);
  assert.equal(g().checked && !g().indeterminate, true);
  click(g());
  assert.equal(wakeLinks(root).length, 0);
  const body = $(root, '#fmenu-links-g-wakes');
  const d = () => $(root, '[data-group="wakes"] button.disclose');
  assert.equal(isHidden(body), true);
  click(d());
  assert.equal(d().getAttribute('aria-expanded'), 'true');
  assert.equal(isHidden($(root, '#fmenu-links-g-wakes')), false);
});

test('legend and Links popover share state', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const item = () => $(root, '.legend-item[data-key="wake"]');
  assert.equal(item().getAttribute('aria-pressed'), 'true');
  click(item());
  assert.equal(item().getAttribute('aria-pressed'), 'false');
  assert.equal($(root, 'input[name="link:wake"]').checked, false);
  assert.deepEqual(wakeLinks(root).map((n) => n.classList.contains('heartbeat')), [true]);
  assert.equal(summaryOf(root, 'links'), 'Links · 5 of 6');
  setChecked($(root, 'input[name="link:wake"]'), true);
  assert.equal(item().getAttribute('aria-pressed'), 'true');
});

test('toggling a checkbox or reloading keeps the popover open and the focus on the same checkbox', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click(btn(root, 'links'));
  const box = $(root, 'input[name="link:spawn"]');
  box.focus();
  setChecked(box, false);
  assert.equal(isHidden(pop(root, 'links')), false);
  assert.equal(document.activeElement, $(root, 'input[name="link:spawn"]'));
  await app.load();
  assert.equal(isHidden(pop(root, 'links')), false);
  assert.equal(document.activeElement?.getAttribute('name'), 'link:spawn');
});

test('Projects None draws no bars and shows the empty hint; All restores them and removes the hint', async () => {
  const { root, app } = boot(payload());
  await app.load();
  assert.equal($(root, '.empty-hint'), null);
  click($(root, '#fmenu-projects button[name="none"]'));
  assert.equal(bars(root), 0);
  assert.equal($(root, '.empty-hint[role="status"]') !== null, true);
  click($(root, '#fmenu-projects button[name="all"]'));
  assert.ok(bars(root) > 0);
  assert.equal($(root, '.empty-hint'), null);
});

test('a project that appears on reload is visible under All and stays hidden under an explicit subset', async () => {
  const p = payload();
  const { root, app } = boot(p);
  await app.load();
  const names = () => [...root.querySelectorAll('.project-label')].map((n) => n.textContent);
  const withNew = two();
  Object.assign(p, withNew);
  await app.load();
  assert.ok(names().includes('other'));
  // explicit subset: only proj; then another project appears
  const q = payload();
  const b = boot(q);
  await b.app.load();
  q.trees.push(two().trees[1]);
  Object.assign(q.sessions, { root2: two().sessions.root2, x1: two().sessions.x1 });
  b.app.state.filters.projects = new Set(['proj']);
  await b.app.load();
  const after = [...b.root.querySelectorAll('.project-label')].map((n) => n.textContent);
  assert.equal(after.includes('other'), false);
  assert.equal(after.includes('proj'), true);
});

test('ArrowDown from the search box focuses the first row checkbox', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click(btn(root, 'projects'));
  key($(root, 'input[name="search:projects"]'), 'ArrowDown');
  assert.equal(document.activeElement, $(root, 'input[name="project:proj"]'));
});

test('an explicit subset whose other items vanish reads "1 of 1", not All, and a new item stays hidden', async () => {
  const p = two();
  const { root, app } = boot(p);
  await app.load();
  click($(root, '#fmenu-projects .fmenu-row[data-key="proj"] button.only'));
  const bShrunk = payload();
  p.trees = bShrunk.trees;
  await app.load();
  assert.equal(summaryOf(root, 'projects'), 'Projects · 1 of 1');
  const w = two();
  p.trees = w.trees;
  await app.load();
  assert.equal(summaryOf(root, 'projects'), 'Projects · 1 of 2');
  const names = [...root.querySelectorAll('.project-label')].map((n) => n.textContent);
  assert.deepEqual(names, ['proj']);
});

test('a root whose workers span two projects renders a single root checkbox', async () => {
  const p = three();
  const { root, app } = boot(p);
  await app.load();
  assert.equal(root.querySelectorAll('input[name="root:root"]').length, 1);
});

test('focus survives a reload that really rebuilds the row list', async () => {
  const p = payload();
  const { root, app } = boot(p);
  await app.load();
  click(btn(root, 'links'));
  $(root, 'input[name="link:forward"]').focus();
  p.linkTypes = [...p.linkTypes, 'set_mode'];
  await app.load();
  assert.ok($(root, 'input[name="link:set_mode"]'), 'list was rebuilt with the new type');
  assert.equal(document.activeElement, $(root, 'input[name="link:forward"]'));
});

test('search matches group names and item names; disclose is disabled while searching and groups show expanded', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click(btn(root, 'links'));
  const search = $(root, 'input[name="search:links"]');
  const type = (q) => { search.value = q; search.dispatchEvent(new win.Event('input', { bubbles: true })); };
  type('driv');
  assert.ok($(root, 'input[name="link:send_prompt"]') && $(root, 'input[name="link:forward"]'));
  assert.equal($(root, 'input[name="link:spawn"]'), null);
  assert.equal(isHidden($(root, '#fmenu-links-g-driving')), false);
  assert.equal($(root, '[data-group="driving"] button.disclose').hasAttribute('disabled'), true);
  type('spawn');
  assert.ok($(root, 'input[name="link:spawn"]'));
  assert.deepEqual([...root.querySelectorAll('#fmenu-links [data-group]')].map((n) => n.getAttribute('data-group')), ['lifecycle']);
  type('');
  assert.equal($(root, '[data-group="lifecycle"] button.disclose').hasAttribute('disabled'), false);
});

test('clicking the button again closes; the query is cleared on close', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click(btn(root, 'links'));
  const search = $(root, 'input[name="search:links"]');
  search.value = 'wake';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  click(btn(root, 'links'));
  assert.equal(isHidden(pop(root, 'links')), true);
  click(btn(root, 'links'));
  assert.equal($(root, 'input[name="search:links"]').value, '');
  assert.ok($(root, 'input[name="link:send_prompt"]'));
});

test('a group toggle under a search flips only the visible members', async () => {
  const p = payload();
  p.linkTypes = ['spawn', 'set_mode', 'set_idle_timeout', 'renew_session', 'prune_session'];
  const { root, app } = boot(p);
  await app.load();
  click(btn(root, 'links'));
  const search = $(root, 'input[name="search:links"]');
  search.value = 'set_';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  click($(root, 'input[name="group:config"]'));
  search.value = '';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  const on = (t) => $(root, `input[name="link:${t}"]`).checked;
  assert.deepEqual(['set_mode', 'set_idle_timeout', 'renew_session', 'prune_session'].map(on), [false, false, true, true]);
});

test('legend focus stays on the clicked button; heartbeat follows wake with a dotted swatch', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const keys = [...root.querySelectorAll('.legend-item')].map((n) => n.getAttribute('data-key'));
  assert.equal(keys[keys.indexOf('wake') + 1], 'heartbeat');
  assert.equal($(root, '.legend-item[data-key="heartbeat"] .swatch').classList.contains('dotted'), true);
  assert.equal($(root, '.legend-item[data-key="forward"] .swatch').classList.contains('dotted'), false);
  const b = $(root, '.legend-item[data-key="wake"]');
  b.focus();
  click(b);
  assert.equal(document.activeElement, $(root, '.legend-item[data-key="wake"]'));
});

test('Conductors None shows the empty hint inside the chart host', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click($(root, '#fmenu-roots button[name="none"]'));
  assert.ok($(root, '.chart-host .empty-hint[role="status"]'));
});

test('arrow keys on a group checkbox do not change expansion while a search is active', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click(btn(root, 'links'));
  const search = $(root, 'input[name="search:links"]');
  search.value = 'wake';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  key(search, 'ArrowDown');
  assert.equal(document.activeElement, $(root, 'input[name="group:wakes"]'));
  key(document.activeElement, 'ArrowRight');
  search.value = '';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal(isHidden($(root, '#fmenu-links-g-wakes')), true);
});

test('the Links summary counts every item, not only the rows a search leaves visible', async () => {
  const { root, app } = boot(payload());
  await app.load();
  setChecked($(root, 'input[name="link:wake"]'), false);
  click(btn(root, 'links'));
  const search = $(root, 'input[name="search:links"]');
  search.value = 'wake';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal(summaryOf(root, 'links'), 'Links · 5 of 6');
});

test('the Conductors button reflects its selection', async () => {
  const { root, app } = boot(two());
  await app.load();
  assert.equal(summaryOf(root, 'roots'), 'Conductors · All');
  click($(root, '#fmenu-roots .fmenu-row[data-key="root"] button.only'));
  assert.equal(summaryOf(root, 'roots'), 'Conductors · 1 of 2');
});

// root touches proj and third; root2 touches other.
const three = () => {
  const p = two();
  p.trees[0].rows.push({ id: 'w3', depth: 1, role: 'worker' });
  p.sessions.w3 = { ...p.sessions.w2, id: 'w3', project: 'third' };
  return p;
};
const listedKeys = (root, dim) => [...root.querySelectorAll(`#fmenu-${dim} .fmenu-row`)].map((n) => n.getAttribute('data-key'));
const onlyRoot = (root, id) => click($(root, `#fmenu-roots .fmenu-row[data-key="${id}"] button.only`));
const checked = (root, name) => $(root, `input[name="${name}"]`).checked;
const projectLabels = (root) => [...root.querySelectorAll('.project-label')].map((n) => n.textContent);

test('Conductors comes first, before Projects and Links, and no toolbar text says Trees', async () => {
  const { root, app } = boot(two());
  await app.load();
  const names = [...root.querySelectorAll('.filter-row button.fmenu-btn')].map((b) => b.getAttribute('name'));
  assert.deepEqual(names, ['filter:roots', 'filter:projects', 'filter:links']);
  assert.match(summaryOf(root, 'roots'), /^Conductors/);
  assert.doesNotMatch($(root, '.filter-row').textContent, /Trees/);
});

test('the Conductors selection narrows the Projects list; All restores it', async () => {
  const { root, app } = boot(three());
  await app.load();
  assert.deepEqual(listedKeys(root, 'projects'), ['other', 'proj', 'third']);
  onlyRoot(root, 'root');
  assert.deepEqual(listedKeys(root, 'projects'), ['proj', 'third']);
  onlyRoot(root, 'root2');
  assert.deepEqual(listedKeys(root, 'projects'), ['other']);
  click($(root, '#fmenu-roots button[name="all"]'));
  assert.deepEqual(listedKeys(root, 'projects'), ['other', 'proj', 'third']);
});

test('a deselected project hidden by narrowing comes back deselected', async () => {
  const { root, app } = boot(three());
  await app.load();
  setChecked($(root, 'input[name="project:proj"]'), false);
  assert.equal(summaryOf(root, 'projects'), 'Projects · 2 of 3');
  onlyRoot(root, 'root2');
  assert.equal(checked(root, 'project:other'), true);
  assert.equal(summaryOf(root, 'projects'), 'Projects · 1 of 1');
  click($(root, '#fmenu-roots button[name="all"]'));
  assert.equal(checked(root, 'project:proj'), false);
  assert.equal(checked(root, 'project:third'), true);
  assert.equal(projectLabels(root).includes('proj'), false);
});

test('Projects None and "only" act on listed projects; hidden selected projects survive', async () => {
  const { root, app } = boot(three());
  await app.load();
  onlyRoot(root, 'root');
  click($(root, '#fmenu-projects button[name="none"]'));
  assert.equal(bars(root), 0);
  assert.match($(root, '.empty-hint').textContent, /project/i);
  click($(root, '#fmenu-roots button[name="all"]'));
  assert.equal(checked(root, 'project:other'), true);
  assert.equal(projectLabels(root).includes('other'), true);
  assert.equal(checked(root, 'project:proj'), false);
  assert.equal(checked(root, 'project:third'), false);

  onlyRoot(root, 'root');
  click($(root, '#fmenu-projects .fmenu-row[data-key="third"] button.only'));
  click($(root, '#fmenu-roots button[name="all"]'));
  assert.equal(checked(root, 'project:third'), true);
  assert.equal(checked(root, 'project:other'), true);
  assert.equal(checked(root, 'project:proj'), false);
});

test('Projects collapse to All only when the hidden projects are selected too', async () => {
  const a = boot(three());
  await a.app.load();
  onlyRoot(a.root, 'root');
  click($(a.root, '#fmenu-projects button[name="none"]'));
  click($(a.root, '#fmenu-projects button[name="all"]'));
  click($(a.root, '#fmenu-roots button[name="all"]'));
  assert.equal(summaryOf(a.root, 'projects'), 'Projects · All');

  const b = boot(three());
  await b.app.load();
  setChecked($(b.root, 'input[name="project:other"]'), false);
  onlyRoot(b.root, 'root');
  click($(b.root, '#fmenu-projects button[name="all"]'));
  click($(b.root, '#fmenu-roots button[name="all"]'));
  assert.equal(summaryOf(b.root, 'projects'), 'Projects · 2 of 3');
});

test('Projects never narrows the Conductors list', async () => {
  const { root, app } = boot(two());
  await app.load();
  click($(root, '#fmenu-projects .fmenu-row[data-key="proj"] button.only'));
  assert.deepEqual(listedKeys(root, 'roots'), ['root', 'root2']);
});

test('Conductors None leaves the Projects list empty with a status and names conductors in the chart hint', async () => {
  const { root, app } = boot(three());
  await app.load();
  click($(root, '#fmenu-roots button[name="none"]'));
  assert.equal(listedKeys(root, 'projects').length, 0);
  assert.notEqual($(root, '#fmenu-projects .fmenu-empty').textContent, '');
  assert.match($(root, '.empty-hint').textContent, /conductor/i);
  click($(root, '#fmenu-projects button[name="all"]'));
  click($(root, '#fmenu-projects button[name="none"]'));
  assert.equal(app.state.filters.projects, null);
});

// --- axis brush ---
const ptr = (node, type, x, extra = {}) => node.dispatchEvent(new win.PointerEvent(type, { bubbles: true, clientX: x, pointerId: 1, isPrimary: true, button: 0, ...extra }));
const hitOf = (root) => root.querySelector('.axis-hit');
const bands = (root) => root.querySelectorAll('.brush-band').length;
const escape = () => document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const drag = (root, a, b) => { ptr(hitOf(root), 'pointerdown', LABEL_W + a); ptr(hitOf(root), 'pointermove', LABEL_W + b); };

test('dragging across the time scale shows a band, captures the pointer, and zooms on release', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  assert.equal(bands(root), 1);
  assert.equal(hitOf(root).hasPointerCapture(1), true);
  ptr(hitOf(root), 'pointerup', LABEL_W + 300);
  assert.equal(bands(root), 0);
  const v = app.state.view;
  const w = app.state.payload.window;
  assert.ok(w.from <= v.from && v.from < v.to && v.to <= w.to);
  assert.ok(v.to - v.from < w.to - w.from);
});

test('a right-to-left drag over the same pixels zooms to the same view', async () => {
  const a = boot(payload());
  await a.app.load();
  drag(a.root, 100, 300);
  ptr(hitOf(a.root), 'pointerup', LABEL_W + 300);
  const b = boot(payload());
  await b.app.load();
  drag(b.root, 300, 100);
  ptr(hitOf(b.root), 'pointerup', LABEL_W + 100);
  assert.deepEqual(b.app.state.view, a.app.state.view);
});

test('a click or sub-threshold drag on the time scale does not zoom', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 100);
  ptr(hitOf(root), 'pointerup', LABEL_W + 100);
  assert.equal(app.state.view, null);
  assert.equal(bands(root), 0);
  drag(root, 100, 102);
  ptr(hitOf(root), 'pointerup', LABEL_W + 102);
  assert.equal(app.state.view, null);
  assert.equal(bands(root), 0);
});

test('Escape during a drag aborts it; a later pointerup does nothing', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  escape();
  assert.equal(bands(root), 0);
  assert.equal(app.state.view, null);
  ptr(hitOf(root), 'pointerup', LABEL_W + 300);
  assert.equal(app.state.view, null);
});

test('pointercancel during a drag aborts it', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  ptr(hitOf(root), 'pointercancel', LABEL_W + 300);
  assert.equal(bands(root), 0);
  assert.equal(app.state.view, null);
});

test('only a primary-button press starts a brush', async () => {
  const { root, app } = boot(payload());
  await app.load();
  ptr(hitOf(root), 'pointerdown', LABEL_W + 100, { button: 2 });
  assert.equal(bands(root), 0);
  assert.equal(hitOf(root).hasPointerCapture(1), false);
});

test('dragging the rows does not start a brush', async () => {
  const { root, app } = boot(payload());
  await app.load();
  ptr(root.querySelector('.plot-bg'), 'pointerdown', LABEL_W + 100);
  assert.equal(bands(root), 0);
});

test('Reset zoom after a drag zoom restores the window; Range keeps the loaded range', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  ptr(hitOf(root), 'pointerup', LABEL_W + 300);
  assert.ok(app.state.view);
  assert.equal(root.querySelector('select[name=range]').value, String(app.state.rangeMs));
  click(root.querySelector('button[name="reset-zoom"]'));
  assert.equal(app.state.view, null);
});

test('a reload during a drag is deferred until the drag ends', async () => {
  for (const mode of ['commit', 'abort', 'click']) {
    let current = payload();
    document.body.replaceChildren();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = mount(host, { getJson: async () => current, subscribe: null });
    await app.load();
    const svg = host.querySelector('svg.chart');
    drag(host, 100, mode === 'click' ? 101 : 300);
    const more = payload();
    more.sessions.w3 = { ...more.sessions.w2, id: 'w3' };
    more.trees[0].rows.push({ id: 'w3', depth: 1, role: 'worker' });
    current = more;
    await app.load();
    assert.equal(svg.isConnected, true, mode);
    assert.equal(bands(host), 1, mode);
    assert.equal(host.querySelector('[data-id="w3"]'), null, mode);
    if (mode === 'abort') escape();
    else ptr(hitOf(host), 'pointerup', LABEL_W + (mode === 'click' ? 101 : 300));
    assert.ok(host.querySelector('[data-id="w3"]'), mode);
    assert.equal(app.state.view === null, mode !== 'commit', mode);
    assert.equal(bands(host), 0, mode);
  }
});

test('losing pointer capture mid-drag aborts the brush and clears the deferral', async () => {
  let current = payload();
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = mount(host, { getJson: async () => current, subscribe: null });
  await app.load();
  drag(host, 100, 300);
  ptr(hitOf(host), 'lostpointercapture', LABEL_W + 300);
  assert.equal(bands(host), 0);
  assert.equal(app.state.view, null);
  const more = payload();
  more.sessions.w3 = { ...more.sessions.w2, id: 'w3' };
  more.trees[0].rows.push({ id: 'w3', depth: 1, role: 'worker' });
  current = more;
  await app.load();
  assert.ok(host.querySelector('[data-id="w3"]'));
});

test('the band follows the drag live', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const band = () => root.querySelector('.brush-band');
  const num = (a) => Number(band().getAttribute(a));
  ptr(hitOf(root), 'pointerdown', LABEL_W + 100);
  assert.equal(num('width'), 0);
  ptr(hitOf(root), 'pointermove', LABEL_W + 300);
  assert.equal(num('x'), LABEL_W + 100);
  assert.equal(num('width'), 200);
  ptr(hitOf(root), 'pointermove', LABEL_W + 40);
  assert.equal(num('x'), LABEL_W + 40);
  assert.equal(num('width'), 60);
  escape();
});

test('pointer identity: another pointer cannot move or end the brush, and a second press adds no band', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  const snap = () => { const b = root.querySelector('.brush-band'); return [b.getAttribute('x'), b.getAttribute('width')]; };
  const before = snap();
  ptr(hitOf(root), 'pointermove', LABEL_W + 500, { pointerId: 2 });
  ptr(hitOf(root), 'pointerup', LABEL_W + 500, { pointerId: 2 });
  assert.deepEqual(snap(), before);
  assert.equal(app.state.view, null);
  ptr(hitOf(root), 'pointerdown', LABEL_W + 50, { pointerId: 2 });
  assert.equal(bands(root), 1);
  assert.equal(hitOf(root).hasPointerCapture(1), true);
  escape();
});

test('a non-primary pointerdown starts no band', async () => {
  const { root, app } = boot(payload());
  await app.load();
  ptr(hitOf(root), 'pointerdown', LABEL_W + 100, { isPrimary: false });
  assert.equal(bands(root), 0);
});

// happy-dom's WheelEvent ignores clientX, ctrlKey and metaKey in its init dict, so they are defined on the event.
function wheelAt(node, clientX, { ctrlKey = false, metaKey = false } = {}) {
  const e = new win.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
  for (const [k, value] of Object.entries({ clientX, ctrlKey, metaKey })) Object.defineProperty(e, k, { value });
  node.dispatchEvent(e);
  return e;
}

test('wheel zoom maps the cursor through the shared plot origin', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const w = app.state.payload.window;
  // Default width 1100 → plot width 836; the plot centre is the window centre.
  const wheel = wheelAt(root.querySelector('svg.chart'), LABEL_W + 418, { ctrlKey: true });
  const v = app.state.view;
  assert.ok(v.to - v.from < w.to - w.from);
  assert.ok(Math.abs((v.from + v.to) / 2 - (w.from + w.to) / 2) < 1);
  assert.equal(wheel.defaultPrevented, true);
});

test('Escape is only intercepted during a gesture', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  assert.equal(bands(root), 1);
  assert.equal(hitOf(root).hasPointerCapture(1), true);
  ptr(hitOf(root), 'pointerup', LABEL_W + 300);
  const esc = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(esc);
  assert.equal(esc.defaultPrevented, false);
});

test('the release position is what commits the brush', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  ptr(hitOf(root), 'pointerup', LABEL_W + 500);
  const w = app.state.payload.window;
  const want = brushView(timeScale(w.from, w.to, 836), 100, 500, w);
  assert.ok(Math.abs(app.state.view.from - want.from) < 1e-6);
  assert.ok(Math.abs(app.state.view.to - want.to) < 1e-6);
});

test('choosing a Range after a brush zoom clears the view and shows the new range', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  ptr(hitOf(root), 'pointerup', LABEL_W + 300);
  assert.ok(app.state.view);
  const sel = root.querySelector('select[name=range]');
  const other = [...sel.options].find((o) => o.value !== String(app.state.rangeMs));
  sel.value = other.value;
  sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.equal(app.state.view, null);
  assert.equal(app.state.rangeMs, Number(other.value));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(root.querySelector('select[name=range]').value, other.value);
});

// --- scroll body ---
const sq = (root, sel) => root.querySelector(sel);

test('the time scale is outside the scroll container', async () => {
  const { root, app } = boot(payload());
  await app.load();
  assert.ok(sq(root, '.chart-scale-box svg.chart-scale .axis'));
  assert.ok(sq(root, '.chart-scale-box svg.chart-scale .axis-hit'));
  const scroll = sq(root, '.chart-scroll');
  assert.ok(scroll.querySelector('svg.chart'));
  assert.equal(scroll.querySelector('.axis, .axis-hit'), null);
  assert.equal(sq(root, '.chart-overlay').parentElement, sq(root, '.chart-host'));
  for (const sel of ['.filters', '.legend-host', '#details', '.diagnostics']) {
    assert.ok(sq(root, sel));
    assert.equal(scroll.contains(sq(root, sel)), false, sel);
  }
});

test('the time scale and the rows share width and plot origin', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const scale = sq(root, 'svg.chart-scale');
  const rows = sq(root, 'svg.chart');
  assert.equal(scale.getAttribute('width'), rows.getAttribute('width'));
  const ticks = new Set([...scale.querySelectorAll('.axis text')].map((t) => t.getAttribute('x')));
  const grid = new Set([...rows.querySelectorAll('line.grid')].map((l) => l.getAttribute('x1')));
  assert.ok(ticks.size > 0);
  assert.deepEqual(ticks, grid);
});

test('row labels and their bars scroll together', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const rows = sq(root, '.chart-scroll > svg.chart');
  const labels = root.querySelectorAll('.row-label');
  const barGs = root.querySelectorAll('.bar-g');
  assert.ok(labels.length > 0 && barGs.length > 0);
  for (const n of [...labels, ...barGs]) assert.equal(n.closest('svg'), rows);
});

test('the scroll position and scroller survive every kind of render', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const scroller = sq(root, '.chart-scroll');
  scroller.scrollTop = 120;
  // happy-dom does not clamp, so this pins scroller identity and restoration; the harness covers real clamping.
  const steps = [
    () => app.load(),
    () => win.dispatchEvent(new win.Event('resize')),
    () => wheelAt(sq(root, 'svg.chart'), LABEL_W + 100, { ctrlKey: true }),
    () => click(sq(root, '.legend-item[data-key="wake"]')),
    () => click(sq(root, '.bar-g')),
  ];
  for (const step of steps) {
    const before = sq(root, 'svg.chart');
    await step();
    assert.notEqual(sq(root, 'svg.chart'), before, 'a render happened');
    assert.equal(sq(root, '.chart-scroll'), scroller);
    assert.equal(scroller.scrollTop, 120);
  }
});

test('a plain wheel over the rows scrolls instead of zooming', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const e = wheelAt(sq(root, 'svg.chart'), LABEL_W + 100);
  assert.equal(app.state.view, null);
  assert.equal(e.defaultPrevented, false);
});

test('meta+wheel over the rows zooms', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const w = app.state.payload.window;
  const e = wheelAt(sq(root, 'svg.chart'), LABEL_W + 100, { metaKey: true });
  assert.ok(app.state.view.to - app.state.view.from < w.to - w.from);
  assert.equal(e.defaultPrevented, true);
});

test('a plain wheel over the time scale zooms', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const w = app.state.payload.window;
  const e = wheelAt(sq(root, 'svg.chart-scale'), LABEL_W + 100);
  assert.ok(app.state.view.to - app.state.view.from < w.to - w.from);
  assert.equal(e.defaultPrevented, true);
});

test('the brush band lives in the overlay and spans it', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  const band = sq(root, '.brush-band');
  assert.equal(band.parentElement, sq(root, '.chart-overlay'));
  assert.equal(band.getAttribute('y'), '0');
  assert.equal(band.getAttribute('height'), '100%');
  assert.equal(hitOf(root).hasPointerCapture(1), true);
});

test('hover tooltips live in the overlay and a render clears them', async () => {
  const { root, app } = boot(payload());
  await app.load();
  sq(root, '.link-g[data-type="wake"]').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 50 }));
  assert.ok(sq(root, '.chart-overlay g.tooltip'));
  await app.load();
  assert.equal(sq(root, 'g.tooltip'), null);
});

test('the empty hint does not accumulate across renders', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click($(root, '#fmenu-roots button[name="none"]'));
  await app.load();
  await app.load();
  assert.equal(root.querySelectorAll('.chart-scroll .empty-hint').length, 1);
  click($(root, '#fmenu-roots button[name="all"]'));
  assert.equal(root.querySelectorAll('.empty-hint').length, 0);
});

test('a render writes the saved scrollTop back after swapping the rows', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const scroller = sq(root, '.chart-scroll');
  scroller.scrollTop = 120;
  // A browser can reset the offset when the content is swapped; emulate that.
  const swap = scroller.replaceChildren.bind(scroller);
  scroller.replaceChildren = (...n) => { swap(...n); scroller.scrollTop = 0; };
  await app.load();
  assert.equal(scroller.scrollTop, 120);
});

test('the chart width comes from the scroller clientWidth', async () => {
  const { root, app } = boot(payload());
  Object.defineProperty(sq(root, '.chart-scroll'), 'clientWidth', { value: 900 });
  await app.load();
  assert.equal(sq(root, 'svg.chart').getAttribute('width'), '900');
  assert.equal(sq(root, 'svg.chart-scale').getAttribute('width'), '900');
});

test('the overlay and tooltips stay in the accessibility tree; the brush band and crosshair are hidden', async () => {
  const { root, app } = boot(payload());
  await app.load();
  assert.equal(sq(root, '.chart-overlay').hasAttribute('aria-hidden'), false);
  drag(root, 100, 300);
  assert.equal(sq(root, '.brush-band').getAttribute('aria-hidden'), 'true');
  assert.equal(cross(root).getAttribute('aria-hidden'), 'true');
  escape();
});

const cross = (root) => root.querySelector('.chart-overlay g.crosshair');
const crossX = (root) => Number(cross(root).querySelector('line').getAttribute('x1'));
const crossText = (root) => cross(root).querySelector('text').textContent;
const leave = (root) => sq(root, '.chart-host').dispatchEvent(new win.PointerEvent('pointerleave'));
const hover = (root, x) => ptr(hitOf(root), 'pointermove', LABEL_W + x);
const scaleOf = (app) => { const v = app.state.view ?? app.state.payload.window; return timeScale(v.from, v.to, 836); };

test('hovering the time scale draws a crosshair line spanning the overlay and a readout of the hovered time', async () => {
  const { root, app } = boot(payload());
  await app.load();
  hover(root, 200);
  const g = cross(root);
  assert.equal(root.querySelectorAll('.chart-overlay g.crosshair').length, 1);
  assert.equal(g.getAttribute('aria-hidden'), 'true');
  const line = g.querySelector('line');
  assert.equal(line.getAttribute('x1'), String(LABEL_W + 200));
  assert.equal(line.getAttribute('x2'), line.getAttribute('x1'));
  assert.equal(line.getAttribute('y1'), '0');
  assert.equal(line.getAttribute('y2'), '100%');
  const sc = scaleOf(app);
  assert.equal(crossText(root), readout(sc, sc.invert(200)));
  assert.match(crossText(root), /^\d\d-\d\d \d\d:\d\d:\d\d$/);
});

test('the crosshair disappears when the pointer leaves the time scale', async () => {
  const { root, app } = boot(payload());
  await app.load();
  hover(root, 200);
  leave(root);
  assert.equal(cross(root), null);
  hover(root, 200);
  ptr(sq(root, 'svg.chart'), 'pointermove', LABEL_W + 200);
  assert.equal(cross(root), null);
});

test('no crosshair over the label column of the time scale', async () => {
  const { root, app } = boot(payload());
  await app.load();
  ptr(sq(root, '.axis-bg'), 'pointermove', 100);
  ptr(sq(root, 'svg.chart-scale'), 'pointermove', 100);
  assert.equal(cross(root), null);
});

test('during a brush drag the crosshair follows the pointer, clamped to the plot', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  assert.equal(bands(root), 1);
  assert.equal(crossX(root), LABEL_W + 300);
  ptr(hitOf(root), 'pointermove', 10);
  assert.equal(crossX(root), LABEL_W);
  ptr(hitOf(root), 'pointermove', LABEL_W + 2000);
  assert.equal(crossX(root), LABEL_W + 836);
  escape();
});

test('committing a brush zooms and hides the crosshair until the next move', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const before = app.state.payload.window;
  drag(root, 100, 300);
  ptr(hitOf(root), 'pointerup', LABEL_W + 300);
  const v = app.state.view;
  assert.ok(v.to - v.from < before.to - before.from);
  assert.equal(bands(root), 0);
  assert.equal(cross(root), null);
  hover(root, 50);
  const sc = timeScale(v.from, v.to, 836);
  assert.equal(crossText(root), readout(sc, sc.invert(50)));
});

test('Escape aborts the brush and leaves no band while the crosshair stays with the pointer', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  escape();
  assert.equal(app.state.view, null);
  assert.equal(bands(root), 0);
  assert.equal(crossX(root), LABEL_W + 300);
});

test('a re-render while hovering keeps the crosshair at the pointer with the new scale', async () => {
  const p = payload();
  const { root, app } = boot(p);
  await app.load();
  hover(root, 200);
  const first = crossText(root);
  p.window = { from: 5000, to: 15_000 };
  await app.load();
  assert.equal(crossX(root), LABEL_W + 200);
  const shifted = scaleOf(app);
  assert.equal(crossText(root), readout(shifted, shifted.invert(200)));
  assert.notEqual(crossText(root), first);
  // zoom around a pixel far from the hovered one: the readout there changes with the scale
  hover(root, 800);
  const before = crossText(root);
  wheelAt(sq(root, 'svg.chart-scale'), LABEL_W + 400);
  const sc = scaleOf(app);
  assert.ok(app.state.view);
  assert.equal(crossX(root), LABEL_W + 800);
  assert.equal(crossText(root), readout(sc, sc.invert(800)));
  assert.notEqual(crossText(root), before);
});

test('the readout pill sits right of the line, and flips left of it near the right edge, inside the scale', async () => {
  const { root, app } = boot(payload());
  await app.load();
  const pill = () => { const r = cross(root).querySelector('.crosshair-readout rect'); return [Number(r.getAttribute('x')), Number(r.getAttribute('width'))]; };
  const width = Number(sq(root, 'svg.chart-scale').getAttribute('width'));
  hover(root, 200);
  let [x, w] = pill();
  assert.ok(x > LABEL_W + 200 && x + w <= width);
  hover(root, 700);
  [x, w] = pill();
  assert.ok(x > LABEL_W + 700 && x + w <= width, 'mid-plot still sits right of the line');
  hover(root, 830);
  [x, w] = pill();
  assert.ok(x + w <= LABEL_W + 830 && x >= 0 && x + w <= width);
});

test('a cancelled press clears the crosshair, and the brush with it', async () => {
  const { root, app } = boot(payload());
  await app.load();
  drag(root, 100, 300);
  assert.ok(cross(root));
  ptr(hitOf(root), 'pointercancel', LABEL_W + 300);
  assert.equal(bands(root), 0);
  assert.equal(cross(root), null);
  hover(root, 50);
  ptr(hitOf(root), 'pointercancel', LABEL_W + 50);
  assert.equal(cross(root), null);
});

test('the crosshair sits in the overlay regardless of the rows scroll offset', async () => {
  const { root, app } = boot(payload());
  await app.load();
  sq(root, '.chart-scroll').scrollTop = 120;
  hover(root, 200);
  assert.equal(cross(root).parentElement, sq(root, '.chart-overlay'));
  assert.equal(sq(root, '.chart-scroll g.crosshair'), null);
  assert.equal(cross(root).querySelector('line').getAttribute('y1'), '0');
});

// ---- a forwarded send_prompt: a send_prompt link plus a forward link sharing one `pair`
const pairPayload = (source = 'w2') => {
  const pair = { sender: 'root', source };
  const p = payload();
  p.links.push({ ts: 4000, type: 'send_prompt', from: 'root', to: 'w1', pair }, { ts: 4000, type: 'forward', from: source, to: 'w1', pair });
  return p;
};
const pairLine = (root, type) => sq(root, `.link-g[data-type="${type}"]`);
const num = (node, a) => Number(node.getAttribute(a));
const hoverNode = (node) => node.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 50 }));

test('a forward line sits PAIR_OFFSET_PX right of its send_prompt at every zoom; the send_prompt marks the event time; dot and hit target follow the forward', async () => {
  const { root, app } = boot(pairPayload());
  await app.load();
  const xs = () => {
    const sp = pairLine(root, 'send_prompt');
    const fw = pairLine(root, 'forward');
    const f = sq(fw, '.link');
    return { expected: LABEL_W + scaleOf(app).x(4000), sp: num(sq(sp, '.link'), 'x1'), fw: num(f, 'x1'), fw2: num(f, 'x2'), dot: num(sq(fw, '.link-end'), 'cx'), hit: num(sq(fw, '.link-hit'), 'cx') };
  };
  const before = xs();
  wheelAt(sq(root, 'svg.chart'), LABEL_W + 100, { ctrlKey: true });
  const after = xs();
  assert.notEqual(after.sp, before.sp, 'the zoom moved the lines');
  for (const x of [before, after]) {
    assert.equal(x.fw - x.sp, PAIR_OFFSET_PX);
    assert.equal(x.fw2, x.fw, 'the forward line is vertical');
    assert.equal(x.dot, x.fw);
    assert.equal(x.hit, x.fw);
    assert.ok(Math.abs(x.sp - x.expected) < 1e-6, 'the send_prompt sits exactly at the event time');
  }
});

test('hovering either line of a forward pair names sender → target and the forwarded session', async () => {
  const { root, app } = boot(pairPayload());
  await app.load();
  for (const type of ['send_prompt', 'forward']) {
    const g = pairLine(root, type);
    g.dispatchEvent(new win.MouseEvent('mouseleave', { bubbles: true }));
    assert.equal(sq(root, 'g.tooltip'), null, 'tooltip cleared before hovering');
    hoverNode(g);
    const tip = sq(root, 'g.tooltip');
    const lines = [...tip.querySelectorAll('text')].map((n) => n.textContent);
    assert.equal(lines[0], type);
    assert.equal(lines[1], 'Conductor → Worker one');
    assert.equal(lines[2], 'forwarding Worker two');
  }
});

test('a pair whose source session is not in the payload shows the raw id in the tooltip', async () => {
  const { root, app } = boot(pairPayload('gone0000'));
  await app.load();
  hoverNode(pairLine(root, 'send_prompt'));
  assert.ok(sq(root, 'g.tooltip').textContent.includes('forwarding gone0000'));
});

test('send_prompt and forward toggles hide only their own line', async () => {
  const { root, app } = boot(pairPayload());
  await app.load();
  const count = (t) => root.querySelectorAll(`.link-g[data-type="${t}"]`).length;
  setChecked($(root, 'input[name="link:forward"]'), false);
  assert.deepEqual([count('send_prompt'), count('forward')], [1, 0]);
  setChecked($(root, 'input[name="link:forward"]'), true);
  setChecked($(root, 'input[name="link:send_prompt"]'), false);
  assert.deepEqual([count('send_prompt'), count('forward')], [0, 1]);
});

// ---- section leads: Conductor band, headers, cross-group stubs ----
const leadsPayload = () => {
  const s = (id, project, extra = {}) => ({ id, project, start: 1000, end: 9000, endKind: 'exited', turns: [], turnCount: 0, rotations: [], stages: [], marks: [], ...extra });
  const p = payload();
  p.trees = [{ rootId: 'c', rows: [
    { id: 'c', depth: 0, role: 'conductor' },
    { id: 'l1', depth: 1, role: 'lead' }, { id: 'w1', depth: 2, role: 'worker' },
    { id: 'l2', depth: 1, role: 'lead' },
    { id: 'd1', depth: 1, role: 'worker' },
  ] }];
  p.sessions = { c: s('c', undefined, { title: 'Boss' }), l1: s('l1', '.conduct', { title: 'Lead one' }), w1: s('w1', 'alpha'), l2: s('l2', '.conduct', { title: 'Lead two' }), d1: s('d1', 'alpha', { title: 'Direct' }) };
  p.links = [
    { ts: 2000, type: 'send_prompt', from: 'c', to: 'l1' },
    { ts: 4000, type: 'forward', from: 'd1', to: 'l2' },
  ];
  return p;
};

test('the conductor project renders as a Conductor band holding the conductor and its leads; leads repeat as context headers', async () => {
  const { root, app } = boot(leadsPayload());
  await app.load();
  assert.deepEqual([...root.querySelectorAll('.project-label')].map((n) => n.textContent), ['Conductor', 'alpha']);
  const labels = [...root.querySelectorAll('.row-label')].map((n) => [n.textContent, n.classList.contains('head'), n.classList.contains('context')]);
  assert.deepEqual(labels, [
    ['Boss', true, true], ['Lead one', true, false], ['Lead two', true, false],
    ['Boss', true, true], ['Lead one', true, true], ['w1', false, false], ['Direct', false, false],
  ]);
  assert.ok(root.querySelector('.link-g[data-type="send_prompt"][data-from="c"][data-to="l1"]'), 'conductor → lead is drawn');
});

test('a link between rows of different groups renders a stub with a ring at each end and no line; hovering names the other end and its group', async () => {
  const { root, app } = boot(leadsPayload());
  await app.load();
  assert.equal(root.querySelectorAll('.link-g:not(.link-stub)[data-type="forward"]').length, 0);
  const stubs = [...root.querySelectorAll('.link-g.link-stub[data-type="forward"]')];
  assert.equal(stubs.length, 2);
  for (const g of stubs) {
    assert.equal(g.getAttribute('data-from'), 'd1');
    assert.equal(g.getAttribute('data-to'), 'l2');
    assert.ok(g.querySelector('circle.link-stub-end'));
  }
  assert.equal(stubs.filter((g) => g.querySelector('.link-end')).length, 1, 'only the target end keeps the filled dot');
  const tipOf = (g) => {
    g.dispatchEvent(new win.MouseEvent('mouseleave', { bubbles: true }));
    hoverNode(g.querySelector('.link-hit'));
    return [...root.querySelector('g.tooltip').querySelectorAll('text')].map((n) => n.textContent);
  };
  const target = stubs.find((g) => g.querySelector('.link-end'));
  const source = stubs.find((g) => !g.querySelector('.link-end'));
  assert.equal(tipOf(source)[0], 'forward');
  assert.ok(tipOf(source).some((l) => l.includes('Lead two') && l.includes('Conductor')), 'the source stub names the target and its group');
  assert.ok(tipOf(target).some((l) => l.includes('Direct') && l.includes('alpha')), 'the target stub names the source and its group');
  setChecked($(root, 'input[name="link:forward"]'), false);
  assert.equal(root.querySelectorAll('.link-stub').length, 0);
});
