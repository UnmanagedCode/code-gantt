import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, defaultFilters, ROW_H } from '../../public/lib/layout.js';

const S = (id, start, end, extra = {}) => ({ id, start, end, endKind: 'exited', turns: [], stages: [], rotations: [], marks: [], turnCount: 0, ...extra });
const payload = () => ({
  now: 10_000,
  window: { from: 0, to: 10_000 },
  linkTypes: ['spawn', 'send_prompt', 'forward', 'wake', 'other'],
  projects: [
    { project: 'A', trees: [{ rootId: 'r', rows: [{ id: 'r', depth: 0, context: true }, { id: 'a1', depth: 1, context: false }] }] },
    { project: 'B', trees: [
      { rootId: 'r', rows: [{ id: 'r', depth: 0, context: true }, { id: 'b1', depth: 1, context: false }] },
      { rootId: 'r2', rows: [{ id: 'r2', depth: 0, context: true }, { id: 'b2', depth: 1, context: false }] },
    ] },
  ],
  sessions: {
    r: S('r', 0, 9000), a1: S('a1', 100, 900), b1: S('b1', 5000, 6000), r2: S('r2', 0, 9000), b2: S('b2', 100, 200),
  },
  links: [
    { ts: 150, type: 'spawn', from: 'r', to: 'a1' },
    { ts: 5100, type: 'send_prompt', from: 'r', to: 'b1' },
    { ts: 5200, type: 'wake', from: 'b1', to: 'r' },
    { ts: 5300, type: 'wake', from: 'b1', to: 'r', heartbeat: true },
    { ts: 160, type: 'spawn', from: 'r2', to: 'b2' },
  ],
});
const ids = (res) => res.rows.filter((r) => r.kind === 'row').map((r) => r.id);
const types = (res) => res.links.map((l) => l.type + (l.heartbeat ? '*' : ''));

test('with default filters every group, row and link is shown', () => {
  const p = payload();
  const res = applyFilters(p, defaultFilters(p));
  assert.deepEqual(res.rows.filter((r) => r.kind === 'project').map((r) => r.project), ['A', 'B']);
  assert.deepEqual(ids(res), ['r', 'a1', 'r', 'b1', 'r2', 'b2']);
  assert.equal(res.links.length, 5);
});

test('project filter removes exactly the other groups and their exclusive links', () => {
  const p = payload();
  const res = applyFilters(p, { ...defaultFilters(p), projects: new Set(['A']) });
  assert.deepEqual(ids(res), ['r', 'a1']);
  assert.deepEqual(res.links.map((l) => l.to), ['a1']);
});

test('tree-root filter keeps only the chosen trees', () => {
  const p = payload();
  const res = applyFilters(p, { ...defaultFilters(p), roots: new Set(['r2']) });
  assert.deepEqual(ids(res), ['r2', 'b2']);
  assert.deepEqual(res.rows.filter((r) => r.kind === 'project').map((r) => r.project), ['B']);
});

test('date-range filter drops non-overlapping sessions and out-of-range links; context rows stay with a shown child', () => {
  const p = payload();
  const res = applyFilters(p, { ...defaultFilters(p), from: 4000, to: 7000 });
  assert.deepEqual(ids(res), ['r', 'b1']);
  assert.deepEqual(types(res), ['send_prompt', 'wake', 'wake*']);
});

test('link-type filter removes exactly that type', () => {
  const p = payload();
  const types0 = new Set(p.linkTypes);
  types0.delete('send_prompt');
  const res = applyFilters(p, { ...defaultFilters(p), linkTypes: types0 });
  assert.equal(res.links.some((l) => l.type === 'send_prompt'), false);
  assert.equal(res.links.length, 4);
});

test('the heartbeat toggle is independent of wake', () => {
  const p = payload();
  const noWake = new Set(p.linkTypes); noWake.delete('wake');
  const a = applyFilters(p, { ...defaultFilters(p), linkTypes: noWake });
  assert.deepEqual(types(a).filter((t) => t.startsWith('wake')), ['wake*']);
  const b = applyFilters(p, { ...defaultFilters(p), heartbeat: false });
  assert.deepEqual(types(b).filter((t) => t.startsWith('wake')), ['wake']);
  const c = applyFilters(p, { ...defaultFilters(p), heartbeat: false, linkTypes: noWake });
  assert.deepEqual(types(c).filter((t) => t.startsWith('wake')), []);
});

test('link endpoints map to their rows’ y; the shared root row is picked within the other endpoint’s group; hidden endpoints drop the link', () => {
  const p = payload();
  const res = applyFilters(p, defaultFilters(p));
  const rowY = (id, project) => res.rows.find((r) => r.kind === 'row' && r.id === id && r.project === project).y;
  const l = res.links.find((x) => x.type === 'send_prompt');
  assert.equal(l.y1, rowY('r', 'B') + ROW_H / 2);
  assert.equal(l.y2, rowY('b1', 'B') + ROW_H / 2);
  const sp = res.links.find((x) => x.to === 'a1');
  assert.equal(sp.y1, rowY('r', 'A') + ROW_H / 2);
  const hidden = applyFilters(p, { ...defaultFilters(p), from: 4000, to: 7000 });
  assert.equal(hidden.links.some((x) => x.to === 'a1'), false);
});
