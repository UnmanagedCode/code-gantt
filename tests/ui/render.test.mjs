import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { PROMPT_SENTINEL as S } from '../helpers/sentinel.mjs';

const win = new Window({ url: 'http://localhost/', width: 1200, height: 800 });
for (const k of ['document', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[k] = win[k];
globalThis.window = win;

const { el, svgEl } = await import('../../public/lib/dom.js');
const { mount } = await import('../../public/app.js');

const EVIL = '<img src=x onerror=alert(1)>';
const EVIL2 = '"><script>x</script>';

function payload(over = {}) {
  const s = (id, extra) => ({ id, start: 1000, end: 9000, endKind: 'exited', turns: [[2000, 3000]], turnCount: 4, rotations: [{ at: 5000, reason: 'renew' }], stages: [{ stage: 'plan', from: 1000, to: 5000 }, { stage: 'implement', from: 5000, to: 9000, via: 'approve_plan' }], marks: [], ...extra });
  return {
    now: 10_000, window: { from: 0, to: 10_000 }, version: 1,
    linkTypes: ['spawn', 'send_prompt', 'forward', 'wake', 'other'],
    projects: [{ project: 'proj', trees: [{ rootId: 'root', rows: [{ id: 'root', depth: 0, context: true, note: S }, { id: 'w1', depth: 1, context: false }, { id: 'w2', depth: 1, context: false }] }] }],
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
  p.projects[0].trees[0].rows.push({ id: EVIL, depth: 1, context: false });
  p.links.push({ ts: 8000, type: 'spawn', from: 'root', to: EVIL });
  p.projects[0].project = EVIL;
  p.sessions.w1 = { ...p.sessions.w1, id: 'w1', title: EVIL2, project: EVIL, worktree: EVIL, model: EVIL2, playbook: EVIL,
    stages: [{ stage: EVIL, from: 1000, to: 9000, via: EVIL2 }] };
  p.linkTypes.push(EVIL);
  p.links.push({ ts: 7000, type: EVIL, from: 'root', to: 'w1' });
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
  p.projects[0].trees[0].rows.push({ id: 'constructor', depth: 1, context: false });
  const { root, app } = boot(p);
  await app.load();
  click([...root.querySelectorAll('.bar-g')].find((n) => n.getAttribute('data-id') === 'constructor'));
  assert.ok(root.querySelector('#details').textContent.includes('constructor'));
  delete p.sessions.constructor;
  p.projects[0].trees[0].rows.pop();
  await app.load();
  assert.match(root.querySelector('#details').textContent, /Select a bar/);
});

// U1: an empty chart is explained. Asserted on role/state (the status banner), not wording.
test('with horizon null the status banner is non-empty; with a horizon it is empty', async () => {
  const p = payload();
  const withHorizon = boot(p);
  await withHorizon.app.load();
  assert.equal(withHorizon.root.querySelector('.banner').textContent, '');
  const none = payload({ projects: [], sessions: {}, links: [] });
  none.diagnostics.horizon = null;
  const b = boot(none);
  await b.app.load();
  assert.notEqual(b.root.querySelector('.banner').textContent, '');
  // T5: keyed on the horizon, not on an empty chart
  const empty = boot(payload({ projects: [], sessions: {}, links: [] }));
  await empty.app.load();
  assert.equal(empty.root.querySelector('.banner').textContent, '');
});

// ---- filter popovers and legend ----
const two = () => {
  const p = payload();
  p.projects.push({ project: 'other', trees: [{ rootId: 'root2', rows: [{ id: 'root2', depth: 0, context: true }, { id: 'x1', depth: 1, context: false }] }] });
  p.sessions.root2 = { ...p.sessions.root, id: 'root2', title: 'Second' };
  p.sessions.x1 = { ...p.sessions.w2, id: 'x1', endKind: 'exited', end: 9000 };
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
  q.projects.push(two().projects[1]);
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
  p.projects = bShrunk.projects;
  await app.load();
  assert.equal(summaryOf(root, 'projects'), 'Projects · 1 of 1');
  const w = two();
  p.projects = w.projects;
  await app.load();
  assert.equal(summaryOf(root, 'projects'), 'Projects · 1 of 2');
  const names = [...root.querySelectorAll('.project-label')].map((n) => n.textContent);
  assert.deepEqual(names, ['proj']);
});

test('the same root under two projects renders a single root checkbox', async () => {
  const p = two();
  p.projects[1].trees.push({ rootId: 'root', rows: [{ id: 'root', depth: 0, context: true }, { id: 'w1', depth: 1, context: false }] });
  const { root, app } = boot(p);
  await app.load();
  assert.equal(root.querySelectorAll('input[name="root:root"]').length, 1);
});

test('focus survives a reload that really rebuilds the row list', async () => {
  const p = payload();
  const { root, app } = boot(p);
  await app.load();
  click(btn(root, 'links'));
  $(root, 'input[name="link:spawn"]').focus();
  p.linkTypes = [...p.linkTypes, 'set_mode'];
  await app.load();
  assert.ok($(root, 'input[name="link:set_mode"]'), 'list was rebuilt with the new type');
  assert.equal(document.activeElement, $(root, 'input[name="link:spawn"]'));
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
  const b = $(root, '.legend-item[data-key="wake"]');
  b.focus();
  click(b);
  assert.equal(document.activeElement, $(root, '.legend-item[data-key="wake"]'));
});

test('Trees None shows the empty hint inside the chart host', async () => {
  const { root, app } = boot(payload());
  await app.load();
  click($(root, '#fmenu-roots button[name="none"]'));
  assert.ok($(root, '.chart-host .empty-hint[role="status"]'));
});
