import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFrom } from '../../src/jsonlTail.js';

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-'));
  return { d, f: path.join(d, 'x.jsonl'), done: () => fs.rmSync(d, { recursive: true, force: true }) };
}

test('complete lines are returned and offset lands after the last newline', async () => {
  const t = tmp();
  fs.writeFileSync(t.f, '{"a":1}\n{"a":2}\n');
  const r = await readFrom(t.f, 0);
  assert.deepEqual(r.lines.map((l) => l.value), [{ a: 1 }, { a: 2 }]);
  assert.equal(r.offset, 16);
  assert.equal(r.lines[1].byteOffset, 8);
  t.done();
});

test('torn trailing line is not consumed; once completed it is returned exactly once', async () => {
  const t = tmp();
  fs.writeFileSync(t.f, '{"a":1}\n{"a":');
  const r1 = await readFrom(t.f, 0);
  assert.equal(r1.lines.length, 1);
  assert.equal(r1.offset, 8);
  fs.appendFileSync(t.f, '2}\n');
  const r2 = await readFrom(t.f, r1.offset);
  assert.deepEqual(r2.lines.map((l) => l.value), [{ a: 2 }]);
  const r3 = await readFrom(t.f, r2.offset);
  assert.equal(r3.lines.length, 0);
  t.done();
});

test('only appended bytes are read next time (poison: earlier bytes rewritten are not seen)', async () => {
  const t = tmp();
  fs.writeFileSync(t.f, '{"k":"AAAA"}\n');
  const r1 = await readFrom(t.f, 0);
  const fd = fs.openSync(t.f, 'r+');
  fs.writeSync(fd, '{"k":"BBBB"}\n', 0);
  fs.closeSync(fd);
  fs.appendFileSync(t.f, '{"k":"CCCC"}\n');
  const r2 = await readFrom(t.f, r1.offset);
  assert.deepEqual(r2.lines.map((l) => l.value.k), ['CCCC']);
  t.done();
});

test('a file that grows during a read is read only up to the open-time size', async () => {
  const t = tmp();
  fs.writeFileSync(t.f, '{"a":1}\n');
  const r = await readFrom(t.f, 0, { onOpen: () => fs.appendFileSync(t.f, '{"a":2}\n') });
  assert.deepEqual(r.lines.map((l) => l.value), [{ a: 1 }]);
  assert.equal(r.offset, 8);
  const r2 = await readFrom(t.f, r.offset);
  assert.deepEqual(r2.lines.map((l) => l.value), [{ a: 2 }]);
  t.done();
});

test('size < offset resets and re-reads from 0', async () => {
  const t = tmp();
  fs.writeFileSync(t.f, '{"a":1}\n{"a":2}\n');
  const r1 = await readFrom(t.f, 0);
  fs.writeFileSync(t.f, '{"b":9}\n');
  const r2 = await readFrom(t.f, r1.offset);
  assert.equal(r2.reset, true);
  assert.deepEqual(r2.lines.map((l) => l.value), [{ b: 9 }]);
  t.done();
});

test('malformed non-trailing line is reported with byte offset and following lines still read', async () => {
  const t = tmp();
  fs.writeFileSync(t.f, '{"a":1}\nnot json\n{"a":3}\n');
  const r = await readFrom(t.f, 0);
  assert.deepEqual(r.lines.map((l) => l.value), [{ a: 1 }, { a: 3 }]);
  assert.deepEqual(r.corrupt, [{ byteOffset: 8 }]);
  t.done();
});

test('missing file gives missing:true and does not throw', async () => {
  const r = await readFrom('/nonexistent-dir-xyz/none.jsonl', 0);
  assert.equal(r.missing, true);
  assert.deepEqual(r.lines, []);
});
