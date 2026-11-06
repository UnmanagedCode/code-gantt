import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeStore, sess } from '../helpers/store.mjs';
import { loadSessions } from '../../src/store/sessions.js';

test('wrapped doc is parsed, unknown fields ignored, children indexed', async () => {
  const s = makeStore({ sessions: {
    root1: { ...sess({ id: 'root1' }), futureField: { x: 1 } },
    kid1: sess({ id: 'kid1', parent: 'root1', project: 'p', conducted: true }),
  } });
  const r = await loadSessions(s.storeDir, null);
  assert.deepEqual([...r.byId.keys()].sort(), ['kid1', 'root1']);
  assert.deepEqual(r.children.get('root1'), ['kid1']);
  assert.equal(r.missing, false);
  s.cleanup();
});

test('byBacking maps every non-dropped segment id to its public id', async () => {
  const s = makeStore({ sessions: {
    a: { current: 'b2', segments: [
      { id: 'b1', reason: 'initial', at: '2026-11-01T00:00:00Z' },
      { id: 'b2', reason: 'renew', at: '2026-11-01T01:00:00Z' },
      { id: 'b3', reason: 'prune', at: '2026-11-01T02:00:00Z', dropped: true },
    ] },
  } });
  const r = await loadSessions(s.storeDir, null);
  assert.equal(r.byBacking.get('b1'), 'a');
  assert.equal(r.byBacking.get('b2'), 'a');
  assert.equal(r.byBacking.has('b3'), false);
  s.cleanup();
});

test('missing file gives empty maps plus missing', async () => {
  const s = makeStore();
  fs.rmSync(s.files.sessions);
  const r = await loadSessions(s.storeDir, null);
  assert.equal(r.byId.size, 0);
  assert.equal(r.missing, true);
  s.cleanup();
});

test('invalid JSON keeps the previous snapshot and sets a diagnostic', async () => {
  const s = makeStore({ sessions: { a: sess({ id: 'a' }) } });
  const first = await loadSessions(s.storeDir, null);
  fs.writeFileSync(s.files.sessions, '{"sessions": {');
  const second = await loadSessions(s.storeDir, first);
  assert.deepEqual([...second.byId.keys()], ['a']);
  assert.match(second.error, /sessions\.json/);
  s.cleanup();
});
