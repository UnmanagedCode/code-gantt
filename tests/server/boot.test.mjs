import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('server.js exits non-zero with a clear message when CONDUCTOR_PLUGIN_DATA_DIR is unset', () => {
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../server.js')], {
    env: { PATH: process.env.PATH, PROJECTS_ROOT: '/nonexistent-root-for-test' },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /CONDUCTOR_PLUGIN_DATA_DIR/);
});
