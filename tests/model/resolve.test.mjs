import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveId } from '../../src/model/resolve.js';

const byId = new Map(['aaaa1111', 'aaaa2222', 'bbbb3333', 'cccc4444'].map((id) => [id, { id }]));
const byBacking = new Map([['11111111-2222-4333-8444-555555555555', 'bbbb3333']]);
const ctx = (scope) => ({ byId, byBacking, scope });

test('exact public id matches', () => {
  assert.equal(resolveId('bbbb3333', ctx(null)), 'bbbb3333');
});

test('a backing id resolves to its public id', () => {
  assert.equal(resolveId('11111111-2222-4333-8444-555555555555', ctx(null)), 'bbbb3333');
});

test('a unique prefix within the owner tree beats a global ambiguity', () => {
  assert.equal(resolveId('aaaa', ctx(null)), null);
  assert.equal(resolveId('aaaa', ctx(new Set(['aaaa2222', 'cccc4444']))), 'aaaa2222');
});

test('a unique global prefix resolves; ambiguous, unknown and too-short ids → null', () => {
  assert.equal(resolveId('bbbb', ctx(null)), 'bbbb3333');
  assert.equal(resolveId('zzzz9999', ctx(null)), null);
  assert.equal(resolveId('a', ctx(null)), null);
  assert.equal(resolveId(undefined, ctx(null)), null);
});
