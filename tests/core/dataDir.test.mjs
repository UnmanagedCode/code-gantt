import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDataDir } from '../../src/dataDir.js';

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-'));
  return { root, dir: path.join(root, 'data'), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('atomic write round-trips and leaves no tmp file', () => {
  const t = tmp();
  const dd = createDataDir(t.dir);
  dd.ensure();
  dd.writeJsonAtomic('c.json', { a: 1 });
  assert.deepEqual(dd.readJson('c.json'), { a: 1 });
  assert.deepEqual(fs.readdirSync(t.dir), ['c.json']);
  t.done();
});

test('dir is created with mode 0700', () => {
  const t = tmp();
  createDataDir(t.dir).ensure();
  assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700);
  t.done();
});

test('writing outside the data dir throws, including .. and symlink escapes', () => {
  const t = tmp();
  const dd = createDataDir(t.dir);
  dd.ensure();
  assert.throws(() => dd.writeJsonAtomic('../evil.json', {}), /outside/);
  assert.throws(() => dd.writeJsonAtomic('/etc/evil.json', {}), /outside/);
  const outside = path.join(t.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(t.dir, 'link'));
  assert.throws(() => dd.writeJsonAtomic('link/x.json', {}), /outside/);
  assert.deepEqual(fs.readdirSync(outside), []);
  t.done();
});

test('readJson returns null for a missing or unreadable file', () => {
  const t = tmp();
  const dd = createDataDir(t.dir);
  dd.ensure();
  assert.equal(dd.readJson('none.json'), null);
  fs.writeFileSync(path.join(t.dir, 'bad.json'), '{oops');
  assert.equal(dd.readJson('bad.json'), null);
  t.done();
});
