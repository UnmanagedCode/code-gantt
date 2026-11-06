import test from 'node:test';
import assert from 'node:assert/strict';
import { buildForest, groupByProject } from '../../src/model/tree.js';
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

test('a cross-project tree appears under each touched project with context ancestors dimmed', () => {
  const { trees } = forestOf({
    r: {},
    lead: { parent: 'r', project: 'A' },
    wa: { parent: 'lead', project: 'B' },
    wb: { parent: 'r', project: 'B' },
    wc: { parent: 'r', project: 'A' },
  });
  const groups = groupByProject(trees);
  assert.deepEqual(groups.map((g) => g.project), ['A', 'B']);
  const rowsOf = (g) => g.trees[0].rows.map((x) => [x.id, x.depth, x.context]);
  assert.deepEqual(rowsOf(groups[0]), [['r', 0, true], ['lead', 1, false], ['wc', 1, false]]);
  assert.deepEqual(rowsOf(groups[1]), [['r', 0, true], ['lead', 1, true], ['wa', 2, false], ['wb', 1, false]]);
});

test('a root is never a group of its own (no undefined project group)', () => {
  const { trees } = forestOf({ r: {}, k: { parent: 'r', project: 'p' } });
  const groups = groupByProject(trees);
  assert.deepEqual(groups.map((g) => g.project), ['p']);
});

test('a parent loop terminates and is counted', () => {
  const { trees, loops } = forestOf({ a: { parent: 'b', project: 'p' }, b: { parent: 'a', project: 'p' } });
  assert.equal(loops, 1);
  assert.equal(trees.length, 1);
  assert.equal(trees[0].rows.length, 2);
});
