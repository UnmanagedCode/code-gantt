import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'conductor.plugin.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

test('manifest name, navLabel, <title> and <h1> all read exactly "Code Gantt"', () => {
  assert.equal(manifest.name, 'Code Gantt');
  assert.equal(manifest.frontend.navLabel, 'Code Gantt');
  assert.equal(/<title>([^<]*)<\/title>/.exec(html)[1], 'Code Gantt');
  assert.equal(/<h1>([^<]*)<\/h1>/.exec(html)[1], 'Code Gantt');
});

test('frontend keys stay within the keys cc’s manifest validator allows', () => {
  const allowed = ['path', 'navLabel', 'keepAlive', 'icon'];
  assert.deepEqual(Object.keys(manifest.frontend).filter((k) => !allowed.includes(k)), []);
});
