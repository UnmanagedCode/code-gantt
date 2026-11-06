import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore } from '../helpers/store.mjs';
import { CostsReader } from '../../src/store/costs.js';

test('turn = [ts - duration_ms, ts]', async () => {
  const s = makeStore({ costs: [{ ts: 10_000, duration_ms: 4000, sessionId: 'a' }] });
  const r = new CostsReader(s.files.costs);
  await r.refresh();
  assert.deepEqual(r.turnsBySession.get('a'), [[6000, 10_000]]);
  s.cleanup();
});

test('negative or null duration gives a zero-length turn at ts', async () => {
  const s = makeStore({ costs: [
    { ts: 5000, duration_ms: -30, sessionId: 'a' },
    { ts: 7000, duration_ms: null, sessionId: 'a' },
    { ts: 9000, sessionId: 'a' },
  ] });
  const r = new CostsReader(s.files.costs);
  await r.refresh();
  assert.deepEqual(r.turnsBySession.get('a'), [[5000, 5000], [7000, 7000], [9000, 9000]]);
  s.cleanup();
});

test('rows group by sessionId and rows without one are skipped', async () => {
  const s = makeStore({ costs: [
    { ts: 1, sessionId: 'a' }, { ts: 2, sessionId: 'b' }, { ts: 3, sessionId: 'a' }, { ts: 4 },
  ] });
  const r = new CostsReader(s.files.costs);
  await r.refresh();
  assert.equal(r.turnsBySession.get('a').length, 2);
  assert.equal(r.turnsBySession.get('b').length, 1);
  assert.equal(r.turnsBySession.size, 2);
  s.cleanup();
});

test('incremental append adds only new rows', async () => {
  const s = makeStore({ costs: [{ ts: 1, sessionId: 'a' }] });
  const r = new CostsReader(s.files.costs);
  await r.refresh();
  s.appendCosts({ ts: 2, sessionId: 'a' });
  await r.refresh();
  assert.equal(r.turnsBySession.get('a').length, 2);
  await r.refresh();
  assert.equal(r.turnsBySession.get('a').length, 2);
  s.cleanup();
});

test('file shrink resets accumulated state', async () => {
  const s = makeStore({ costs: [{ ts: 1, sessionId: 'a' }, { ts: 2, sessionId: 'a' }] });
  const r = new CostsReader(s.files.costs);
  await r.refresh();
  const fs = await import('node:fs');
  fs.writeFileSync(s.files.costs, '{"ts":9,"sessionId":"z"}\n');
  await r.refresh();
  assert.equal(r.turnsBySession.has('a'), false);
  assert.equal(r.turnsBySession.get('z').length, 1);
  s.cleanup();
});

test('C5: concurrent refresh() calls on a one-row file yield exactly one turn', async () => {
  const s = makeStore({ costs: [{ ts: 5, sessionId: 'a' }] });
  const r = new CostsReader(s.files.costs);
  await Promise.all([r.refresh(), r.refresh(), r.refresh()]);
  assert.equal(r.turnsBySession.get('a').length, 1);
  s.cleanup();
});
