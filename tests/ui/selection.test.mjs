import test from 'node:test';
import assert from 'node:assert/strict';
import { summary, matches, selectAll, selectNone, only, toggle, triState, toggleGroup } from '../../public/lib/selection.js';

const S = (...k) => new Set(k);

test('summary says All when everything (including 0 of 0) is selected, None for 0 of n, else n of m', () => {
  assert.equal(summary('Projects', 3, 3), 'Projects · All');
  assert.equal(summary('Projects', 0, 0), 'Projects · All');
  assert.equal(summary('Projects', 0, 4), 'Projects · None');
  assert.equal(summary('Projects', 2, 5), 'Projects · 2 of 5');
});

test('matches is a case-insensitive substring match on the trimmed query; empty matches all', () => {
  assert.equal(matches('Send_Prompt', ' prom '), true);
  assert.equal(matches('spawn', 'PROM'), false);
  assert.equal(matches('anything', ''), true);
  assert.equal(matches('anything', '   '), true);
});

test('selectAll/selectNone act only on the given keys, so a search leaves hidden keys alone', () => {
  assert.deepEqual([...selectNone(S('a', 'b', 'c'), ['a', 'b'])], ['c']);
  assert.deepEqual([...selectAll(S('c'), ['a', 'b'])].sort(), ['a', 'b', 'c']);
  assert.equal(selectNone(S('a', 'b'), ['a', 'b']).size, 0);
});

test('only and toggle return new sets without mutating the input', () => {
  assert.deepEqual([...only('x')], ['x']);
  const base = S('a');
  assert.deepEqual([...toggle(base, 'b', true)].sort(), ['a', 'b']);
  assert.deepEqual([...toggle(base, 'a', false)], []);
  assert.deepEqual([...base], ['a']);
});

test('triState reports all, some, none, and none for empty keys', () => {
  assert.equal(triState(S('a', 'b'), ['a', 'b']), 'all');
  assert.equal(triState(S('a'), ['a', 'b']), 'some');
  assert.equal(triState(S('z'), ['a', 'b']), 'none');
  assert.equal(triState(S('a'), []), 'none');
});

test('toggleGroup: some → all, all → none, none → all', () => {
  const keys = ['a', 'b'];
  assert.equal(triState(toggleGroup(S('a'), keys), keys), 'all');
  assert.equal(triState(toggleGroup(S('a', 'b'), keys), keys), 'none');
  assert.equal(triState(toggleGroup(S(), keys), keys), 'all');
});
