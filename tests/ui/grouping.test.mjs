import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRows, treeProjects } from '../../public/lib/grouping.js';

const CP = '.conduct';
const S = (id, project, start = 100, end = 900) => ({ id, project, start, end });
const row = (id, depth, role) => ({ id, depth, role });
const NOW = 10_000;
const sel = (over = {}) => ({ roots: null, projects: null, from: 0, to: NOW, now: NOW, conductorProject: CP, ...over });
// One conductor `c` with two section leads and a direct worker, in DFS (start) order.
const trees = () => [{ rootId: 'c', rows: [
  row('c', 0, 'conductor'),
  row('l1', 1, 'lead'), row('w1', 2, 'worker'), row('w2', 2, 'worker'),
  row('l2', 1, 'lead'),
  row('d1', 1, 'worker'),
] }];
const sessions = () => Object.fromEntries([
  S('c', 'rootproj'), S('l1', CP), S('w1', 'alpha'), S('w2', 'beta'), S('l2', CP), S('d1', 'alpha'),
].map((s) => [s.id, s]));
// kind:id|label:depth:flags:group
const sig = (rows) => rows.map((r) => (r.kind === 'band'
  ? `band:${r.project}:${r.label}`
  : `${r.id}:${r.depth}:${[r.context ? 'ctx' : 'home', r.head].filter(Boolean).join('+')}:${r.group}`));

test('rows are project → conductor → section lead → worker, with headers repeated per project', () => {
  assert.deepEqual(sig(groupRows(trees(), sessions(), sel())), [
    'band:.conduct:Conductor',
    'c:0:ctx+conductor:.conduct', 'l1:1:home+lead:.conduct', 'l2:1:home+lead:.conduct',
    'band:alpha:alpha',
    'c:0:ctx+conductor:alpha', 'l1:1:ctx+lead:alpha', 'w1:2:home:alpha', 'd1:1:home:alpha',
    'band:beta:beta',
    'c:0:ctx+conductor:beta', 'l1:1:ctx+lead:beta', 'w2:2:home:beta',
  ]);
});

test('a lead with no workers still has its header under its conductor in Conductor', () => {
  const rows = groupRows(trees(), sessions(), sel());
  assert.ok(sig(rows).includes('l2:1:home+lead:.conduct'));
  assert.equal(rows.some((r) => r.id === 'l2' && r.group !== CP), false);
});

test('rows carry rootId and path-based unique keys', () => {
  const rows = groupRows(trees(), sessions(), sel());
  assert.ok(rows.every((r) => r.kind === 'band' || r.rootId === 'c'));
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});

test('a conductor with no section leads and no projectless workers appears only under its workers’ projects, never in Conductor', () => {
  const t = [{ rootId: 'r', rows: [row('r', 0, 'conductor'), row('x', 1, 'worker')] }];
  const rows = groupRows(t, { r: S('r', CP), x: S('x', 'alpha') }, sel());
  assert.deepEqual(sig(rows), ['band:alpha:alpha', 'r:0:ctx+conductor:alpha', 'x:1:home:alpha']);
});

test('a worker’s child in another project makes the parent a context row in the child’s group', () => {
  const t = [{ rootId: 'r', rows: [row('r', 0, 'conductor'), row('x', 1, 'worker'), row('y', 2, 'worker')] }];
  const rows = groupRows(t, { r: S('r'), x: S('x', 'alpha'), y: S('y', 'beta') }, sel());
  assert.deepEqual(sig(rows), [
    'band:alpha:alpha', 'r:0:ctx+conductor:alpha', 'x:1:home:alpha',
    'band:beta:beta', 'r:0:ctx+conductor:beta', 'x:1:ctx:beta', 'y:2:home:beta',
  ]);
});

test('a .conduct worker below a lead sits under that lead in Conductor', () => {
  const t = [{ rootId: 'r', rows: [row('r', 0, 'conductor'), row('l', 1, 'lead'), row('m', 2, 'worker')] }];
  const rows = groupRows(t, { r: S('r'), l: S('l', CP), m: S('m', CP) }, sel());
  assert.deepEqual(sig(rows), ['band:.conduct:Conductor', 'r:0:ctx+conductor:.conduct', 'l:1:home+lead:.conduct', 'm:2:home:.conduct']);
});

test('projects sort by name with .conduct first; roots within a project follow tree order', () => {
  const t = [
    { rootId: 'r1', rows: [row('r1', 0, 'conductor'), row('a', 1, 'worker')] },
    { rootId: 'r2', rows: [row('r2', 0, 'conductor'), row('b', 1, 'worker'), row('l', 1, 'lead')] },
  ];
  const ss = { r1: S('r1'), r2: S('r2'), a: S('a', 'zeta'), b: S('b', 'zeta'), l: S('l', CP) };
  const rows = groupRows(t, ss, sel());
  assert.deepEqual(rows.filter((r) => r.kind === 'band').map((r) => r.project), [CP, 'zeta']);
  assert.deepEqual(rows.filter((r) => r.group === 'zeta' && r.head === 'conductor').map((r) => r.id), ['r1', 'r2']);
});

test('Conductors filter drops whole trees', () => {
  assert.deepEqual(groupRows(trees(), sessions(), sel({ roots: new Set() })), []);
  assert.ok(groupRows(trees(), sessions(), sel({ roots: new Set(['c']) })).length > 0);
});

test('Projects filter drops units and the lead self-entries of unselected projects; leads stay as context headers', () => {
  const rows = groupRows(trees(), sessions(), sel({ projects: new Set(['alpha']) }));
  assert.deepEqual(sig(rows), ['band:alpha:alpha', 'c:0:ctx+conductor:alpha', 'l1:1:ctx+lead:alpha', 'w1:2:home:alpha', 'd1:1:home:alpha']);
  const cond = groupRows(trees(), sessions(), sel({ projects: new Set([CP]) }));
  assert.deepEqual(sig(cond), ['band:.conduct:Conductor', 'c:0:ctx+conductor:.conduct', 'l1:1:home+lead:.conduct', 'l2:1:home+lead:.conduct']);
});

test('time filter drops a unit with no overlapping row of its own, but keeps an ancestor of a kept row', () => {
  const ss = sessions();
  ss.w2 = S('w2', 'beta', 100, 200); // outside the window below
  const rows = groupRows(trees(), ss, sel({ from: 700, to: 1000 }));
  assert.equal(rows.some((r) => r.project === 'beta' || r.group === 'beta'), false);
  assert.ok(sig(rows).includes('w1:2:home:alpha'));

  const t = [{ rootId: 'r', rows: [row('r', 0, 'conductor'), row('x', 1, 'worker'), row('y', 2, 'worker')] }];
  const ss2 = { r: S('r'), x: S('x', 'alpha', 100, 200), y: S('y', 'beta', 800, 900) };
  const kept = groupRows(t, ss2, sel({ from: 700, to: 1000 }));
  assert.deepEqual(sig(kept), ['band:beta:beta', 'r:0:ctx+conductor:beta', 'x:1:ctx:beta', 'y:2:home:beta']);
});

test('time filter keeps a lead self-entry only while the lead overlaps', () => {
  const ss = sessions();
  ss.l2 = S('l2', CP, 100, 200);
  const rows = groupRows(trees(), ss, sel({ from: 700, to: 1000 }));
  assert.equal(rows.some((r) => r.id === 'l2'), false);
  assert.ok(rows.some((r) => r.id === 'l1' && r.group === CP));
});

test('treeProjects lists the projects of each tree’s non-root rows that overlap the payload window', () => {
  const ss = sessions();
  ss.w2 = S('w2', 'beta', 20_000, 30_000);
  const m = treeProjects({ trees: trees(), sessions: ss, window: { from: 0, to: NOW }, now: NOW });
  assert.deepEqual([...m.get('c')].sort(), [CP, 'alpha']);
});
