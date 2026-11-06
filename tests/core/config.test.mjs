import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/config.js';

const base = { PROJECTS_ROOT: '/r', CONDUCTOR_PLUGIN_DATA_DIR: '/d' };

test('transcript root precedence: CLAUDE_PROJECTS_ROOT, then CLAUDE_CONFIG_DIR, then HOME/.claude', () => {
  assert.equal(resolveConfig({ ...base, CLAUDE_PROJECTS_ROOT: '/t', CLAUDE_CONFIG_DIR: '/c', HOME: '/h' }).transcriptRoot, '/t');
  assert.equal(resolveConfig({ ...base, CLAUDE_CONFIG_DIR: '/c', HOME: '/h' }).transcriptRoot, '/c/projects');
  assert.equal(resolveConfig({ ...base, HOME: '/h' }).transcriptRoot, '/h/.claude/projects');
});

test('the store dir is <PROJECTS_ROOT>/.code-conductor and conductorUrl is optional', () => {
  const c = resolveConfig(base);
  assert.equal(c.storeDir, '/r/.code-conductor');
  assert.equal(c.conductorUrl, '');
});

test('a missing data dir or projects root throws with a clear message', () => {
  assert.throws(() => resolveConfig({ PROJECTS_ROOT: '/r' }), /CONDUCTOR_PLUGIN_DATA_DIR/);
  assert.throws(() => resolveConfig({ CONDUCTOR_PLUGIN_DATA_DIR: '/d' }), /PROJECTS_ROOT/);
});
