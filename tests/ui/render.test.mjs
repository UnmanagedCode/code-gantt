import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { PROMPT_SENTINEL as S } from '../helpers/sentinel.mjs';

const win = new Window({ url: 'http://localhost/', width: 1200, height: 800 });
for (const k of ['document', 'Node', 'Element', 'Event', 'MouseEvent']) globalThis[k] = win[k];
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
});
