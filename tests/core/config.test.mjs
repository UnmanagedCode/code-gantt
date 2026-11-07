import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/config.js';

test('the store dir is <PROJECTS_ROOT>/.code-conductor and conductorUrl is optional', () => {
  const c = resolveConfig({ PROJECTS_ROOT: '/r' });
  assert.equal(c.storeDir, '/r/.code-conductor');
  assert.equal(c.conductorUrl, '');
});

test('a missing PROJECTS_ROOT throws with a clear message; PROJECTS_ROOT alone is a complete configuration', () => {
  assert.throws(() => resolveConfig({}), /PROJECTS_ROOT/);
  assert.deepEqual(Object.keys(resolveConfig({ PROJECTS_ROOT: '/r' })).sort(), ['conductorUrl', 'projectsRoot', 'storeDir']);
});
