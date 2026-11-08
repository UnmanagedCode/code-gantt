import test from 'node:test';
import assert from 'node:assert/strict';
import { buildForest, CONDUCTOR_PROJECT } from '../../src/model/tree.js';
import { sess, iso, T0, min } from '../helpers/store.mjs';

const mk = (defs) => new Map(Object.entries(defs).map(([id, d]) => [id, { id, ...sess({ id, ...d }) }]));
const forestOf = (defs) => buildForest(mk(defs));

test('a root has no parent; its children render under it sorted by start', () => {
  const { trees } = forestOf({
    r: {},
    late: { parent: 'r', project: 'p', at: iso(T0 + min(10)) },
    early: { parent: 'r', project: 'p', at: iso(T0 + min(1)) },
  });
  assert.equal(trees.length, 1);
  assert.deepEqual(trees[0].rows.map((x) => [x.id, x.depth]), [['r', 0], ['early', 1], ['late', 1]]);
  assert.equal(trees[0].orphan, false);
});

test('a nested lead’s children render under it at depth 2', () => {
  const { trees } = forestOf({
    r: {}, lead: { parent: 'r', project: 'p' }, w: { parent: 'lead', project: 'p' },
  });
  assert.deepEqual(trees[0].rows.map((x) => [x.id, x.depth]), [['r', 0], ['lead', 1], ['w', 2]]);
});

test('a session whose parent is missing becomes an orphan root', () => {
  const { trees } = forestOf({ w: { parent: 'gone', project: 'p' }, c: { parent: 'w', project: 'p' } });
  assert.equal(trees.length, 1);
  assert.equal(trees[0].rootId, 'w');
  assert.equal(trees[0].orphan, true);
});

test('a childless root is excluded', () => {
  const { trees } = forestOf({ lonely: {}, r: {}, k: { parent: 'r', project: 'p' } });
  assert.deepEqual(trees.map((t) => t.rootId), ['r']);
});

test('roles: a root is the conductor; a depth-1 .conduct session is a section lead; every other session is a worker', () => {
  const { trees } = forestOf({
    r: { project: 'rootproj' },
    lead: { parent: 'r', project: CONDUCTOR_PROJECT },
    w: { parent: 'lead', project: 'p' },
    deepConduct: { parent: 'w', project: CONDUCTOR_PROJECT },
    direct: { parent: 'r', project: 'p' },
    kid: { parent: 'direct', project: 'q' },
  });
  const roleOf = Object.fromEntries(trees[0].rows.map((x) => [x.id, x.role]));
  assert.deepEqual(roleOf, { r: 'conductor', lead: 'lead', w: 'worker', deepConduct: 'worker', direct: 'worker', kid: 'worker' });
});

test('roles: a depth-1 non-.conduct session with children is a worker; an orphan root with a .conduct child has a lead', () => {
  const a = forestOf({ r: {}, w: { parent: 'r', project: 'p' }, c: { parent: 'w', project: 'q' } }).trees[0];
  assert.equal(a.rows.find((x) => x.id === 'w').role, 'worker');
  const b = forestOf({ o: { parent: 'gone', project: 'p' }, l: { parent: 'o', project: CONDUCTOR_PROJECT } }).trees[0];
  assert.deepEqual(b.rows.map((x) => [x.id, x.role]), [['o', 'conductor'], ['l', 'lead']]);
});

test('a parent loop terminates and is counted', () => {
  const { trees, loops } = forestOf({ a: { parent: 'b', project: 'p' }, b: { parent: 'a', project: 'p' } });
  assert.equal(loops, 1);
  assert.equal(trees.length, 1);
  assert.equal(trees[0].rows.length, 2);
});

test('S7: a 20k-deep parent chain builds without overflowing the stack', () => {
  const defs = { n0: {} };
  for (let i = 1; i < 20_000; i++) defs[`n${i}`] = { parent: `n${i - 1}`, project: 'p' };
  const { trees } = forestOf(defs);
  assert.equal(trees[0].rows.length, 20_000);
  assert.equal(trees[0].rows.at(-1).depth, 19_999);
});
