import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Validates our manifest with cc's own validator. Run with RUN_CC_MANIFEST=1 and CC_PROJECTS_ROOT set.
const run = process.env.RUN_CC_MANIFEST === '1';

test('conductor.plugin.json passes cc’s own manifest validator', { skip: !run }, async () => {
  const file = path.join(process.env.CC_PROJECTS_ROOT, 'code-conductor/src/plugins/manifest.ts');
  const mod = await import(pathToFileURL(file).href);
  const validate = mod.validateManifest ?? mod.parseManifest;
  assert.equal(typeof validate, 'function');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../conductor.plugin.json'), 'utf8'));
  assert.doesNotThrow(() => validate(manifest, 'code-gantt'));
});
