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
  S('c', CP), S('l1', CP), S('w1', 'alpha'), S('w2', 'beta'), S('l2', CP), S('d1', 'alpha'),
].map((s) => [s.id, s]));
// kind:id|label:depth:flags:group
const sig = (rows) => rows.map((r) => (r.kind === 'band'
  ? `band:${r.project}:${r.label}`
  : `${r.id}:${r.depth}:${[r.context ? 'ctx' : 'home', r.head].filter(Boolean).join('+')}:${r.group}`));

// Invariant: project bands hold one section per owner (the conductor's own, then each lead), each under its own root copy.
test('rows are project → conductor → section lead → worker, one root copy per section in project bands', () => {
  assert.deepEqual(sig(groupRows(trees(), sessions(), sel())), [
    'band:.conduct:Conductor',
    'c:0:ctx+conductor:.conduct', 'l1:1:home+lead:.conduct', 'l2:1:home+lead:.conduct',
    'band:alpha:alpha',
    'c:0:ctx+conductor:alpha', 'd1:1:home:alpha',
    'c:0:ctx+conductor:alpha', 'l1:1:ctx+lead:alpha', 'w1:2:home:alpha',
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
  assert.deepEqual(sig(rows), ['band:alpha:alpha', 'c:0:ctx+conductor:alpha', 'd1:1:home:alpha', 'c:0:ctx+conductor:alpha', 'l1:1:ctx+lead:alpha', 'w1:2:home:alpha']);
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

test('time filter keeps a lead’s Conductor row while the lead overlaps or has a kept worker; a lead with neither is dropped', () => {
  const ss = sessions();
  ss.l1 = S('l1', CP, 100, 200); // outside the window, but w1 (alpha) overlaps
  ss.l2 = S('l2', CP, 100, 200); // outside the window, no workers
  const rows = groupRows(trees(), ss, sel({ from: 700, to: 1000 }));
  assert.ok(rows.some((r) => r.id === 'l1' && r.group === CP && !r.context), 'l1 stays home in Conductor');
  assert.equal(rows.some((r) => r.id === 'l2'), false);
  assert.equal(rows[0].label, 'Conductor');
});

// Invariant: the Conductor band keeps its nesting, interleaving by tree order.
test('in the Conductor band a unit row of the conductor interleaves with lead headers by tree order (the Conductor band keeps its nesting)', () => {
  const t = [{ rootId: 'r', rows: [row('r', 0, 'conductor'), row('l1', 1, 'lead'), row('d', 1, 'worker'), row('l2', 1, 'lead')] }];
  const rows = groupRows(t, { r: S('r'), l1: S('l1', CP), d: S('d', CP), l2: S('l2', CP) }, sel());
  assert.deepEqual(rows.filter((r) => r.kind === 'row').map((r) => r.id), ['r', 'l1', 'd', 'l2']);
});

test('a session with no end is open-ended: it overlaps any window after its start', () => {
  const t = [{ rootId: 'r', rows: [row('r', 0, 'conductor'), row('x', 1, 'worker')] }];
  const ss = { r: S('r'), x: { id: 'x', project: 'alpha', start: 100, end: null } };
  assert.deepEqual(sig(groupRows(t, ss, sel({ from: 5000, to: 6000 }))), ['band:alpha:alpha', 'r:0:ctx+conductor:alpha', 'x:1:home:alpha']);
  const m = treeProjects({ trees: t, sessions: ss, window: { from: 5000, to: 6000 }, now: NOW });
  assert.deepEqual([...m.get('r')], ['alpha']);
});

test('the Conductor label and first position follow conductorProject, not a literal', () => {
  const t = [{ rootId: 'r', rows: [row('r', 0, 'conductor'), row('l', 1, 'lead'), row('x', 1, 'worker')] }];
  const rows = groupRows(t, { r: S('r'), l: S('l', 'zzz'), x: S('x', 'alpha') }, sel({ conductorProject: 'zzz' }));
  assert.deepEqual(rows.filter((r) => r.kind === 'band').map((r) => [r.project, r.label]), [['zzz', 'Conductor'], ['alpha', 'alpha']]);
});

test('treeProjects lists the projects of each tree’s non-root rows that overlap the payload window', () => {
  const ss = sessions();
  ss.w2 = S('w2', 'beta', 20_000, 30_000);
  const m = treeProjects({ trees: trees(), sessions: ss, window: { from: 0, to: NOW }, now: NOW });
  assert.deepEqual([...m.get('c')].sort(), [CP, 'alpha']);
});

// ---- sections: one root copy per section in project bands ----
const coreTrees = () => [{ rootId: 'c', rows: [
  row('c', 0, 'conductor'), row('d1', 1, 'worker'),
  row('l1', 1, 'lead'), row('a1', 2, 'worker'), row('a2', 2, 'worker'),
  row('l2', 1, 'lead'), row('b1', 2, 'worker'), row('b2', 2, 'worker'),
  row('d2', 1, 'worker'),
] }];
const coreSessions = (over = {}) => ({
  ...Object.fromEntries([
    S('c', CP), S('l1', CP), S('l2', CP),
    ...['d1', 'd2', 'a1', 'a2', 'b1', 'b2'].map((id) => S(id, 'alpha')),
  ].map((s) => [s.id, s])), ...over,
});
const ssig = (rows) => rows.map((r) => (r.kind === 'band'
  ? `band:${r.project}:${r.label}`
  : `${r.id}:${r.depth}:${[r.context ? 'ctx' : 'home', r.head].filter(Boolean).join('+')}:${r.group}@${r.section}`));
const CORE_ALPHA = [
  'band:alpha:alpha',
  'c:0:ctx+conductor:alpha@c', 'd1:1:home:alpha@c', 'd2:1:home:alpha@c',
  'c:0:ctx+conductor:alpha@l1', 'l1:1:ctx+lead:alpha@l1', 'a1:2:home:alpha@l1', 'a2:2:home:alpha@l1',
  'c:0:ctx+conductor:alpha@l2', 'l2:1:ctx+lead:alpha@l2', 'b1:2:home:alpha@l2', 'b2:2:home:alpha@l2',
];
const inGroup = (rows, g) => rows.filter((r) => r.kind === 'row' && r.group === g);

test('in a project band each section lead gets its own copy of the root: root → lead → that lead’s workers', () => {
  assert.deepEqual(ssig(groupRows(coreTrees(), coreSessions(), sel())), [
    'band:.conduct:Conductor',
    'c:0:ctx+conductor:.conduct@c', 'l1:1:home+lead:.conduct@c', 'l2:1:home+lead:.conduct@c',
    ...CORE_ALPHA,
  ]);
});

test('the conductor’s direct workers form the band’s first section, under their own root copy, with no lead level, whatever their start', () => {
  const rows = inGroup(groupRows(coreTrees(), coreSessions(), sel()), 'alpha');
  const own = rows.filter((r) => r.section === 'c');
  assert.deepEqual(own.map((r) => [r.id, r.depth]), [['c', 0], ['d1', 1], ['d2', 1]]);
  assert.equal(rows.indexOf(own[0]), 0);
  assert.equal(rows.some((r) => r.head === 'lead' && r.section === 'c'), false);
});

test('a band where the root has no direct workers has no conductor-own section; a lead with no workers in a band has no section there', () => {
  const ss = coreSessions({ d1: S('d1', 'beta'), d2: S('d2', 'beta'), a1: S('a1', 'alpha'), b1: S('b1', 'beta'), b2: S('b2', 'beta') });
  const rows = groupRows(coreTrees(), ss, sel());
  const alpha = inGroup(rows, 'alpha');
  assert.equal(alpha.filter((r) => r.head === 'conductor').length, 1);
  assert.deepEqual([...new Set(alpha.map((r) => r.section))], ['l1']);
  const beta = inGroup(rows, 'beta');
  assert.deepEqual([...new Set(beta.map((r) => r.section))], ['c', 'l2']);
  assert.equal(beta.filter((r) => r.head === 'conductor').length, 2);
});

test('row keys stay unique when the root repeats in a band; every row carries rootId and section', () => {
  const rows = groupRows(coreTrees(), coreSessions(), sel()).filter((r) => r.kind === 'row');
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
  assert.ok(rows.every((r) => r.rootId === 'c' && typeof r.section === 'string'));
});

test('with Conductor deselected the lead sections stay in the project bands', () => {
  assert.deepEqual(ssig(groupRows(coreTrees(), coreSessions(), sel({ projects: new Set(['alpha']) }))), CORE_ALPHA);
});

test('time filter drops a section whose workers all fall outside the window, and its root copy with it', () => {
  const ss = coreSessions({ b1: S('b1', 'alpha', 100, 200), b2: S('b2', 'alpha', 100, 200) });
  const rows = groupRows(coreTrees(), ss, sel({ from: 700, to: 1000 }));
  const alpha = inGroup(rows, 'alpha');
  assert.deepEqual([...new Set(alpha.map((r) => r.section))], ['c', 'l1']);
  assert.equal(alpha.filter((r) => r.head === 'conductor').length, 2);
  assert.ok(rows.some((r) => r.id === 'l2' && r.group === CP), 'l2 still overlaps, so it stays in Conductor');
});
