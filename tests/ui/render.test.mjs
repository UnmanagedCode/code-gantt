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
  const s = (id, extra) => ({ id, start: 1000, end: 9000, endKind: 'retired', turns: [[2000, 3000]], turnCount: 4, rotations: [{ at: 5000, reason: 'renew' }], stages: [{ stage: 'plan', from: 1000, to: 5000 }, { stage: 'implement', from: 5000, to: 9000, via: 'approve_plan' }], marks: [], ...extra });
  return {
    now: 10_000, window: { from: 0, to: 10_000 }, version: 1,
    linkTypes: ['spawn', 'send_prompt', 'forward', 'wake', 'other'],
    projects: [{ project: 'proj', trees: [{ rootId: 'root', rows: [{ id: 'root', depth: 0, context: true }, { id: 'w1', depth: 1, context: false }, { id: 'w2', depth: 1, context: false }] }] }],
    sessions: {
      root: s('root', { title: 'Conductor' }),
      w1: s('w1', { title: 'Worker one', project: 'proj', worktree: 'wt-1', model: 'model-x', playbook: 'classic' }),
      w2: s('w2', { title: 'Worker two', project: 'proj', endKind: 'approx', end: 9500 }),
    },
    links: [
      { ts: 1500, type: 'spawn', from: 'root', to: 'w1', source: 'ledger' },
      { ts: 6000, type: 'wake', from: 'w1', to: 'root', source: 'backfill' },
      { ts: 6500, type: 'wake', from: 'w2', to: 'root', source: 'backfill', heartbeat: true },
    ],
    diagnostics: { liveness: 'unavailable', backfill: { state: 'ready', filesDone: 1, filesTotal: 1 }, cutoff: null, unresolved: 0, unknownTools: {}, unknownKinds: {}, corruptLines: 0, missing: [], errors: [] },
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
  p.projects[0].project = EVIL;
  p.sessions.w1 = { ...p.sessions.w1, id: 'w1', title: EVIL2, project: EVIL, worktree: EVIL, model: EVIL2, playbook: EVIL,
    stages: [{ stage: EVIL, from: 1000, to: 9000, via: EVIL2 }] };
  p.linkTypes.push(EVIL);
  p.links.push({ ts: 7000, type: EVIL, from: 'root', to: 'w1', source: 'ledger' });
  const { root, app } = boot(p);
  await app.load();
  click(root.querySelector('[data-id="w1"]'));
  const g = root.querySelector('.link-g');
  g.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
  for (const bad of ['img', 'script']) assert.equal(document.querySelectorAll(bad).length, 0, bad);
  assert.equal(document.querySelectorAll('[onerror],[onclick]').length, 0);
  const details = root.querySelector('#details');
  assert.ok(details.textContent.includes(EVIL));
  assert.ok(details.textContent.includes(EVIL2));
  assert.ok(root.textContent.includes(EVIL));
});

test('an approx bar exposes "approximate end"; a retired bar does not', async () => {
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

test('the rendered page carries no prompt sentinel and shows the diagnostics', async () => {
  const p = payload();
  const { root, app } = boot(p);
  await app.load();
  assert.equal(document.body.textContent.includes(S), false);
  assert.match(root.querySelector('.diagnostics').textContent, /liveness: unavailable/);
});
