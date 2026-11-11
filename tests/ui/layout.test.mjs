import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, defaultFilters, ROW_H } from '../../public/lib/layout.js';

const S = (id, start, end, extra = {}) => ({ id, start, end, endKind: 'exited', turns: [], stages: [], rotations: [], marks: [], turnCount: 0, ...extra });
const payload = () => ({
  now: 10_000,
  window: { from: 0, to: 10_000 },
  linkTypes: ['spawn', 'send_prompt', 'forward', 'wake', 'other'],
  conductorProject: '.conduct',
  trees: [
    { rootId: 'r', rows: [{ id: 'r', depth: 0, role: 'conductor' }, { id: 'a1', depth: 1, role: 'worker' }, { id: 'b1', depth: 1, role: 'worker' }] },
    { rootId: 'r2', rows: [{ id: 'r2', depth: 0, role: 'conductor' }, { id: 'b2', depth: 1, role: 'worker' }] },
  ],
  sessions: {
    r: S('r', 0, 9000), a1: S('a1', 100, 900, { project: 'A' }), b1: S('b1', 5000, 6000, { project: 'B' }),
    r2: S('r2', 0, 9000), b2: S('b2', 100, 200, { project: 'B' }),
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
  assert.deepEqual(res.rows.filter((r) => r.kind === 'band').map((r) => r.project), ['A', 'B']);
  assert.deepEqual(ids(res), ['r', 'a1', 'r', 'b1', 'r2', 'b2']);
  assert.equal(res.links.length, 5);
  assert.deepEqual(res.stubs, []);
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
  assert.deepEqual(res.rows.filter((r) => r.kind === 'band').map((r) => r.project), ['B']);
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

test('link endpoints map to their rows’ y; the conductor row is picked within the other endpoint’s group; hidden endpoints drop the link', () => {
  const p = payload();
  const res = applyFilters(p, defaultFilters(p));
  const rowY = (id, project) => res.rows.find((r) => r.kind === 'row' && r.id === id && r.group === project).y;
  const l = res.links.find((x) => x.type === 'send_prompt');
  assert.equal(l.y1, rowY('r', 'B') + ROW_H / 2);
  assert.equal(l.y2, rowY('b1', 'B') + ROW_H / 2);
  const sp = res.links.find((x) => x.to === 'a1');
  assert.equal(sp.y1, rowY('r', 'A') + ROW_H / 2);
  const hidden = applyFilters(p, { ...defaultFilters(p), from: 4000, to: 7000 });
  assert.equal(hidden.links.some((x) => x.to === 'a1'), false);
});

test('an empty project Set or root Set draws no rows and no links; null still draws everything', () => {
  const p = payload();
  for (const key of ['projects', 'roots']) {
    const f = defaultFilters(p);
    f[key] = new Set();
    const res = applyFilters(p, f);
    assert.deepEqual([res.rows.length, res.links.length], [0, 0], key);
  }
  const all = applyFilters(p, defaultFilters(p));
  assert.equal(all.rows.length > 0 && all.links.length === 5, true);
});

// A conductor with two section leads (one without workers), a direct worker and a lead-owned worker.
const leadPayload = () => ({
  now: 10_000,
  window: { from: 0, to: 10_000 },
  linkTypes: ['send_prompt', 'forward', 'wake'],
  conductorProject: '.conduct',
  trees: [{ rootId: 'c', rows: [
    { id: 'c', depth: 0, role: 'conductor' },
    { id: 'l1', depth: 1, role: 'lead' }, { id: 'w1', depth: 2, role: 'worker' },
    { id: 'l2', depth: 1, role: 'lead' },
    { id: 'd1', depth: 1, role: 'worker' },
  ] }],
  sessions: {
    c: S('c', 0, 9000), l1: S('l1', 100, 9000, { project: '.conduct' }), w1: S('w1', 200, 900, { project: 'alpha' }),
    l2: S('l2', 300, 9000, { project: '.conduct' }), d1: S('d1', 400, 900, { project: 'alpha' }),
  },
  links: [
    { ts: 1000, type: 'send_prompt', from: 'c', to: 'l1' },
    { ts: 2000, type: 'forward', from: 'd1', to: 'l2' },
    { ts: 3000, type: 'wake', from: 'w1', to: 'l1' },
    { ts: 4000, type: 'send_prompt', from: 'l1', to: 'w1' },
  ],
});
const yOf = (res, id, group) => res.rows.find((r) => r.kind === 'row' && r.id === id && r.group === group).y + ROW_H / 2;

test('conductor → lead is drawn inside Conductor, a lead → worker link inside the worker’s project', () => {
  const p = leadPayload();
  const res = applyFilters(p, defaultFilters(p));
  const cl = res.links.find((l) => l.from === 'c');
  assert.equal(cl.y1, yOf(res, 'c', '.conduct'));
  assert.equal(cl.y2, yOf(res, 'l1', '.conduct'));
  const lw = res.links.find((l) => l.from === 'l1');
  assert.equal(lw.y1, yOf(res, 'l1', 'alpha'));
  assert.equal(lw.y2, yOf(res, 'w1', 'alpha'));
  const wl = res.links.find((l) => l.from === 'w1');
  assert.equal(wl.y1, yOf(res, 'w1', 'alpha'));
  assert.equal(wl.y2, yOf(res, 'l1', 'alpha'));
});

test('a link with no shared group draws no line and a stub at each end, pointing at the other end', () => {
  const p = leadPayload();
  const res = applyFilters(p, defaultFilters(p));
  assert.equal(res.links.some((l) => l.type === 'forward'), false);
  const stubs = res.stubs.filter((s) => s.type === 'forward');
  assert.equal(stubs.length, 2);
  const src = stubs.find((s) => s.end === 'source');
  const tgt = stubs.find((s) => s.end === 'target');
  assert.deepEqual([src.y, src.dir, src.otherId, src.otherGroup], [yOf(res, 'd1', 'alpha'), -1, 'l2', '.conduct']);
  assert.deepEqual([tgt.y, tgt.dir, tgt.otherId, tgt.otherGroup], [yOf(res, 'l2', '.conduct'), 1, 'd1', 'alpha']);
  assert.notEqual(src.key, tgt.key);
});

test('the link group is the one where most ends have their own row, not just the first shared group', () => {
  const p = {
    now: 10_000, window: { from: 0, to: 10_000 }, linkTypes: ['send_prompt'], conductorProject: '.conduct',
    trees: [{ rootId: 'r', rows: [{ id: 'r', depth: 0, role: 'conductor' }, { id: 'x', depth: 1, role: 'worker' }, { id: 'y', depth: 2, role: 'worker' }] }],
    sessions: { r: S('r', 0, 9000), x: S('x', 100, 9000, { project: 'beta' }), y: S('y', 100, 9000, { project: 'alpha' }) },
    links: [{ ts: 1000, type: 'send_prompt', from: 'r', to: 'x' }],
  };
  const res = applyFilters(p, defaultFilters(p));
  assert.equal(res.links[0].y2, yOf(res, 'x', 'beta'));
  assert.equal(res.links[0].y1, yOf(res, 'r', 'beta'));
});

test('a stub sits on the end’s own row, else on its topmost copy', () => {
  const p = leadPayload();
  p.trees[0].rows.push({ id: 'g1', depth: 1, role: 'worker' });
  p.sessions.g1 = S('g1', 500, 9000, { project: 'gamma' });
  p.trees[0].rows.splice(3, 0, { id: 'wb', depth: 2, role: 'worker' });
  p.sessions.wb = S('wb', 250, 900, { project: 'beta' });
  p.links = [{ ts: 1000, type: 'wake', from: 'l1', to: 'g1' }];
  const f = { ...defaultFilters(p), projects: new Set(['alpha', 'beta', 'gamma']) }; // Conductor deselected: l1 has only copies
  const res = applyFilters(p, f);
  const src = res.stubs.find((s) => s.end === 'source');
  assert.equal(src.y, yOf(res, 'l1', 'alpha'));
  assert.equal(src.dir, 1, 'the target row is below the source copy');
  const tgt = res.stubs.find((s) => s.end === 'target');
  assert.equal(tgt.y, yOf(res, 'g1', 'gamma'));
  assert.equal(tgt.dir, -1, 'the source copy is above the target row');
  assert.equal(res.links.length, 0);
});

test('a link with an end that is not drawn has neither line nor stub; the type and heartbeat filters hide stubs', () => {
  const p = leadPayload();
  const hidden = applyFilters(p, { ...defaultFilters(p), from: 950, to: 10_000, linkTypes: new Set(['forward']) });
  assert.deepEqual([hidden.links.length, hidden.stubs.length], [0, 0]);
  const noFwd = new Set(p.linkTypes); noFwd.delete('forward');
  assert.equal(applyFilters(p, { ...defaultFilters(p), linkTypes: noFwd }).stubs.length, 0);
  const onlyProject = applyFilters(p, { ...defaultFilters(p), projects: new Set(['alpha']) });
  assert.equal(onlyProject.stubs.length, 0, 'l2 has no row once Conductor is deselected');
  p.links[1].type = 'wake'; p.links[1].heartbeat = true;
  assert.equal(applyFilters(p, { ...defaultFilters(p), heartbeat: false }).stubs.length, 0);
  assert.equal(applyFilters(p, defaultFilters(p)).stubs.length, 2);
});

const treesPayload = (trees, sessions, links) => ({
  now: 10_000, window: { from: 0, to: 10_000 }, linkTypes: ['send_prompt'], conductorProject: '.conduct', trees, sessions, links,
});
const W = (id, depth) => ({ id, depth, role: 'worker' });
const R = (id) => ({ id, depth: 0, role: 'conductor' });

test('a stub sits on the end’s own row even when a copy of it lies above', () => {
  // x is home in beta and a dimmed copy in alpha (parent of y); alpha sorts above beta
  const p = treesPayload(
    [{ rootId: 'ra', rows: [R('ra'), W('x', 1), W('y', 2)] }, { rootId: 'rb', rows: [R('rb'), W('g', 1)] }],
    { ra: S('ra', 0, 9000), x: S('x', 0, 9000, { project: 'beta' }), y: S('y', 0, 9000, { project: 'alpha' }), rb: S('rb', 0, 9000), g: S('g', 0, 9000, { project: 'gamma' }) },
    [{ ts: 1000, type: 'send_prompt', from: 'x', to: 'g' }],
  );
  const res = applyFilters(p, defaultFilters(p));
  assert.equal(res.stubs.find((s) => s.end === 'source').y, yOf(res, 'x', 'beta'));
  assert.ok(yOf(res, 'x', 'alpha') < yOf(res, 'x', 'beta'));
});

// Invariant: when two sections hold both ends equally, the line goes in the first in row order.
test('when two bands hold both ends equally, the line goes in the first band in row order', () => {
  const p = treesPayload(
    [{ rootId: 'r', rows: [R('r'), W('x', 1), W('y', 2), W('z', 2)] }],
    { r: S('r', 0, 9000), x: S('x', 0, 9000, { project: 'beta' }), y: S('y', 0, 9000, { project: 'alpha' }), z: S('z', 0, 9000, { project: 'gamma' }) },
    [{ ts: 1000, type: 'send_prompt', from: 'r', to: 'x' }],
  );
  const res = applyFilters(p, { ...defaultFilters(p), projects: new Set(['alpha', 'gamma']) });
  assert.equal(res.links.length, 1);
  assert.equal(res.links[0].y1, yOf(res, 'r', 'alpha'));
  assert.equal(res.links[0].y2, yOf(res, 'x', 'alpha'));
});

test('an open-ended session (end null) started before the range keeps its band, row and links', () => {
  const p = treesPayload(
    [{ rootId: 'r', rows: [R('r'), W('x', 1)] }],
    { r: S('r', 0, 9000), x: { id: 'x', project: 'alpha', start: 100, end: null } },
    [{ ts: 6000, type: 'send_prompt', from: 'r', to: 'x' }],
  );
  const res = applyFilters(p, { ...defaultFilters(p), from: 5000, to: 7000 });
  assert.deepEqual(res.rows.filter((r) => r.kind === 'band').map((r) => r.project), ['alpha']);
  assert.deepEqual(ids(res), ['r', 'x']);
  assert.equal(res.links.length, 1);
});

// ---- root ↔ own section-lead links are repeated in each project band holding both context copies ----
const linesFor = (res, from, to) => res.links.filter((l) => l.from === from && l.to === to);
const yBand = (res, group) => res.rows.filter((r) => r.kind === 'row' && r.group === group).map((r) => r.y + ROW_H / 2);
const leadLinks = (links) => {
  const p = leadPayload();
  p.trees[0].rows = [
    { id: 'c', depth: 0, role: 'conductor' },
    { id: 'l1', depth: 1, role: 'lead' }, { id: 'w1', depth: 2, role: 'worker' },
    { id: 'l2', depth: 1, role: 'lead' }, { id: 'w2', depth: 2, role: 'worker' },
    { id: 'd1', depth: 1, role: 'worker' },
  ];
  p.sessions.w2 = S('w2', 250, 900, { project: 'beta' });
  p.links = links;
  return p;
};

test('a root ↔ section-lead link is also drawn in the lead’s project band, between the two context copies', () => {
  const p = leadLinks([{ ts: 1000, type: 'send_prompt', from: 'c', to: 'l1' }]);
  const res = applyFilters(p, defaultFilters(p));
  const ls = linesFor(res, 'c', 'l1');
  assert.equal(ls.length, 2);
  assert.equal(new Set(ls.map((l) => l.key)).size, 2);
  assert.ok(ls.some((l) => l.y1 === yOf(res, 'c', '.conduct') && l.y2 === yOf(res, 'l1', '.conduct')));
  assert.ok(ls.some((l) => l.y1 === yIn(res, 'c', 'alpha', 'l1') && l.y2 === yIn(res, 'l1', 'alpha', 'l1')));
});

test('a root ↔ lead link is not drawn in another project’s band and makes no stub', () => {
  const p = leadLinks([{ ts: 1000, type: 'send_prompt', from: 'c', to: 'l2' }]);
  const res = applyFilters(p, defaultFilters(p));
  const ls = linesFor(res, 'c', 'l2');
  assert.equal(ls.length, 2);
  const alpha = yBand(res, 'alpha');
  assert.ok(ls.every((l) => !alpha.includes(l.y1) && !alpha.includes(l.y2)));
  assert.ok(ls.some((l) => l.y2 === yOf(res, 'l2', 'beta')));
  assert.equal(res.stubs.length, 0);
});

test('the lead → root direction is drawn per band too', () => {
  const p = leadLinks([{ ts: 1000, type: 'wake', from: 'l1', to: 'c' }]);
  const res = applyFilters(p, defaultFilters(p));
  const ls = linesFor(res, 'l1', 'c');
  assert.equal(ls.length, 2);
  assert.ok(ls.some((l) => l.y1 === yIn(res, 'l1', 'alpha', 'l1') && l.y2 === yIn(res, 'c', 'alpha', 'l1')));
});

test('a lead driving two projects gets the root link in each band; with Conductor deselected, once per project band', () => {
  const p = leadLinks([{ ts: 1000, type: 'send_prompt', from: 'c', to: 'l1' }]);
  p.trees[0].rows.splice(3, 0, { id: 'wb', depth: 2, role: 'worker' });
  p.sessions.wb = S('wb', 250, 900, { project: 'beta' });
  const res = applyFilters(p, defaultFilters(p));
  const ls = linesFor(res, 'c', 'l1');
  assert.equal(ls.length, 3);
  assert.ok(ls.some((l) => l.y2 === yOf(res, 'l1', 'beta')));
  assert.ok(ls.some((l) => l.y1 === yIn(res, 'c', 'alpha', 'l1') && l.y2 === yIn(res, 'l1', 'alpha', 'l1')));
  assert.equal(new Set(ls.map((l) => l.key)).size, 3);
  const f = { ...defaultFilters(p), projects: new Set(['alpha', 'beta']) };
  const r2 = applyFilters(p, f);
  assert.deepEqual([linesFor(r2, 'c', 'l1').length, r2.stubs.length], [2, 0]);
});

// Invariant: the direct section and each lead section are separate sections, each with its own root copy.
test('a root’s direct-worker link and its lead link use different root copies in the band', () => {
  const p = leadLinks([{ ts: 1000, type: 'send_prompt', from: 'c', to: 'd1' }, { ts: 1100, type: 'send_prompt', from: 'c', to: 'l1' }]);
  const res = applyFilters(p, defaultFilters(p));
  assert.equal(linesFor(res, 'c', 'd1').length, 1);
  assert.equal(linesFor(res, 'c', 'd1')[0].y1, yIn(res, 'c', 'alpha', 'c'));
  assert.ok(linesFor(res, 'c', 'l1').some((l) => l.y1 === yIn(res, 'c', 'alpha', 'l1') && l.y2 === yIn(res, 'l1', 'alpha', 'l1')));
  assert.notEqual(yIn(res, 'c', 'alpha', 'c'), yIn(res, 'c', 'alpha', 'l1'));
});

// Invariant: a section holds one tree, so cross-tree links are stubs, not lines.
test('cross-tree links are stubs: a section holds one tree', () => {
  const p = treesPayload(
    [{ rootId: 'c', rows: [R('c'), { id: 'l1', depth: 1, role: 'lead' }, W('w1', 2)] }, { rootId: 'c2', rows: [R('c2'), { id: 'l2', depth: 1, role: 'lead' }, W('w2', 2)] }],
    { c: S('c', 0, 9000), l1: S('l1', 0, 9000, { project: '.conduct' }), w1: S('w1', 0, 9000, { project: 'alpha' }),
      c2: S('c2', 0, 9000), l2: S('l2', 0, 9000, { project: '.conduct' }), w2: S('w2', 0, 9000, { project: 'alpha' }) },
    [{ ts: 1000, type: 'send_prompt', from: 'c', to: 'c2' }, { ts: 1100, type: 'send_prompt', from: 'l1', to: 'l2' }, { ts: 1200, type: 'send_prompt', from: 'c', to: 'l2' }],
  );
  const res = applyFilters(p, defaultFilters(p));
  assert.deepEqual([linesFor(res, 'c', 'c2').length, linesFor(res, 'l1', 'l2').length, linesFor(res, 'c', 'l2').length], [0, 0, 0]);
  for (const [f, t] of [['c', 'c2'], ['l1', 'l2'], ['c', 'l2']]) assert.equal(res.stubs.filter((x) => x.from === f && x.to === t).length, 2, `${f}→${t}`);
});

test('a root link to a non-lead worker keeps its single band even when the worker has copies in several bands', () => {
  const p = treesPayload(
    [{ rootId: 'c', rows: [R('c'), W('d1', 1), W('x', 2)] }],
    { c: S('c', 0, 9000), d1: S('d1', 0, 9000, { project: 'alpha' }), x: S('x', 0, 9000, { project: 'beta' }) },
    [{ ts: 1000, type: 'send_prompt', from: 'c', to: 'd1' }],
  );
  const res = applyFilters(p, defaultFilters(p));
  assert.ok(res.rows.filter((r) => r.kind === 'row' && r.id === 'd1').length > 1, 'd1 has a copy in beta');
  const ls = linesFor(res, 'c', 'd1');
  assert.equal(ls.length, 1);
  assert.equal(ls[0].y2, yOf(res, 'd1', 'alpha'));
});

// ---- sections: lines live inside one section (a tree's rows in a band) ----
// The core shape: root c, direct workers d1/d2, leads l1 (a1,a2) and l2 (b1,b2), all workers in alpha.
const sectionsPayload = (links) => ({
  now: 10_000, window: { from: 0, to: 10_000 }, linkTypes: ['send_prompt', 'forward', 'wake', 'spawn'], conductorProject: '.conduct',
  trees: [{ rootId: 'c', rows: [R('c'), W('d1', 1), { id: 'l1', depth: 1, role: 'lead' }, W('a1', 2), W('a2', 2), { id: 'l2', depth: 1, role: 'lead' }, W('b1', 2), W('b2', 2), W('d2', 1)] }],
  sessions: {
    c: S('c', 0, 9000), l1: S('l1', 300, 9000, { project: '.conduct' }), l2: S('l2', 300, 9000, { project: '.conduct' }),
    d1: S('d1', 100, 900, { project: 'alpha' }), d2: S('d2', 500, 900, { project: 'alpha' }),
    a1: S('a1', 400, 900, { project: 'alpha' }), a2: S('a2', 410, 900, { project: 'alpha' }),
    b1: S('b1', 420, 900, { project: 'alpha' }), b2: S('b2', 430, 900, { project: 'alpha' }),
  },
  links,
});
const yIn = (res, id, group, section) => {
  const r = res.rows.find((x) => x.kind === 'row' && x.id === id && x.group === group && x.section === section);
  return r.y + ROW_H / 2;
};
const send = (from, to, ts = 1000) => ({ ts, type: 'send_prompt', from, to });

test('root → lead B is drawn in lead B’s section on that section’s root copy, never in lead A’s section, and is not stubbed', () => {
  const p = sectionsPayload([send('c', 'l2')]);
  const res = applyFilters(p, defaultFilters(p));
  const ls = linesFor(res, 'c', 'l2');
  assert.equal(ls.length, 2);
  assert.ok(ls.some((l) => l.y1 === yIn(res, 'c', '.conduct', 'c') && l.y2 === yIn(res, 'l2', '.conduct', 'c')));
  const inB = ls.find((l) => l.y1 === yIn(res, 'c', 'alpha', 'l2'));
  assert.ok(inB);
  assert.equal(inB.y2, yIn(res, 'l2', 'alpha', 'l2'));
  assert.equal(inB.y2 - inB.y1, ROW_H);
  const sectionA = res.rows.filter((r) => r.kind === 'row' && r.group === 'alpha' && r.section === 'l1').map((r) => r.y + ROW_H / 2);
  assert.ok(ls.every((l) => !sectionA.includes(l.y1) && !sectionA.includes(l.y2)));
  assert.equal(res.stubs.length, 0);
});

test('lead ↔ worker and worker ↔ worker links of one lead are drawn in that lead’s section', () => {
  const p = sectionsPayload([send('l1', 'a1'), { ts: 1100, type: 'wake', from: 'a1', to: 'l1' }, send('a1', 'a2', 1200)]);
  const res = applyFilters(p, defaultFilters(p));
  assert.equal(res.links.length, 3);
  assert.equal(res.stubs.length, 0);
  const l = (f, t) => linesFor(res, f, t)[0];
  assert.deepEqual([l('l1', 'a1').y1, l('l1', 'a1').y2], [yIn(res, 'l1', 'alpha', 'l1'), yIn(res, 'a1', 'alpha', 'l1')]);
  assert.deepEqual([l('a1', 'l1').y1, l('a1', 'l1').y2], [yIn(res, 'a1', 'alpha', 'l1'), yIn(res, 'l1', 'alpha', 'l1')]);
  assert.deepEqual([l('a1', 'a2').y1, l('a1', 'a2').y2], [yIn(res, 'a1', 'alpha', 'l1'), yIn(res, 'a2', 'alpha', 'l1')]);
});

test('a root’s direct-worker link is drawn in the conductor’s own section, on its own root copy', () => {
  const p = sectionsPayload([send('c', 'd2')]);
  const res = applyFilters(p, defaultFilters(p));
  assert.equal(res.links.length, 1);
  assert.equal(res.links[0].y1, yIn(res, 'c', 'alpha', 'c'));
  assert.equal(res.links[0].y2, yIn(res, 'd2', 'alpha', 'c'));
});

test('a root link to a lead’s worker is drawn in that lead’s section', () => {
  const p = sectionsPayload([send('c', 'b1')]);
  const res = applyFilters(p, defaultFilters(p));
  assert.equal(res.links.length, 1);
  assert.equal(res.links[0].y1, yIn(res, 'c', 'alpha', 'l2'));
  assert.equal(res.links[0].y2, yIn(res, 'b1', 'alpha', 'l2'));
});

test('a link crossing sections inside one band is two stubs, not a line', () => {
  const p = sectionsPayload([send('a1', 'l2'), send('d1', 'l1', 1100), send('a1', 'b1', 1200)]);
  const res = applyFilters(p, defaultFilters(p));
  assert.equal(res.links.length, 0);
  const of = (f, t) => res.stubs.filter((s) => s.from === f && s.to === t);
  for (const [f, t] of [['a1', 'l2'], ['d1', 'l1'], ['a1', 'b1']]) assert.equal(of(f, t).length, 2, `${f}→${t}`);
  const [src, tgt] = [of('a1', 'b1').find((s) => s.end === 'source'), of('a1', 'b1').find((s) => s.end === 'target')];
  assert.deepEqual([src.y, src.dir, src.otherGroup], [yIn(res, 'a1', 'alpha', 'l1'), 1, 'alpha']);
  assert.deepEqual([tgt.y, tgt.dir, tgt.otherGroup], [yIn(res, 'b1', 'alpha', 'l2'), -1, 'alpha']);
  assert.equal(of('a1', 'l2').find((s) => s.end === 'target').y, yIn(res, 'l2', '.conduct', 'c'));
});

test('a lead ↔ lead link of one tree is drawn once, in the Conductor band', () => {
  const p = sectionsPayload([send('l1', 'l2')]);
  const res = applyFilters(p, defaultFilters(p));
  assert.equal(res.links.length, 1);
  assert.deepEqual([res.links[0].y1, res.links[0].y2], [yIn(res, 'l1', '.conduct', 'c'), yIn(res, 'l2', '.conduct', 'c')]);
  assert.equal(res.stubs.length, 0);
});
