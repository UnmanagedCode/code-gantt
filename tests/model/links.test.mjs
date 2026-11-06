import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinks } from '../../src/model/links.js';
import { buildForest } from '../../src/model/tree.js';
import { GOVERNED_TOOLS } from '../../src/model/linkTypes.js';
import { sess, iso, T0, min } from '../helpers/store.mjs';

const mk = () => {
  const defs = {
    cond: sess({ id: 'cond' }),
    wrk1: sess({ id: 'wrk1', parent: 'cond', project: 'p', conducted: true, at: iso(T0 + min(5)) }),
    wrk2: sess({ id: 'wrk2', parent: 'cond', project: 'p', conducted: true, at: iso(T0 + min(6)) }),
  };
  const byId = new Map(Object.entries(defs).map(([id, r]) => [id, { id, ...r }]));
  const byBacking = new Map([...byId].flatMap(([id, r]) => r.segments.map((s) => [s.id, id])));
  return { byId, byBacking, forest: buildForest(byId) };
};
const run = (over = {}) => {
  const sessions = mk();
  return buildLinks({ sessions, ledger: [], backfill: { calls: [], wakes: [] }, cutoffTs: null, ...over });
};
const call = (o) => ({ id: 'toolu_' + Math.random(), ts: T0 + min(10), tool: 'send_prompt', target: 'wrk1', owner: 'cond', ok: true, ...o });
const lev = (o) => ({ line: 0, ts: T0 + min(10), kind: 'interaction', conductorSessionId: 'cond', sessionId: 'wrk1', tool: 'send_prompt', ...o });

test('spawn: parent → child at the child start, from sessions.json', () => {
  const { links } = run();
  const sp = links.filter((l) => l.type === 'spawn');
  assert.deepEqual(sp.map((l) => [l.from, l.to, l.ts]), [['cond', 'wrk1', T0 + min(5)], ['cond', 'wrk2', T0 + min(6)]]);
});

test('transition: parent → worker typed via; forwardSessionId makes a forward link source → worker', () => {
  const { links } = run({ ledger: [
    { line: 1, ts: T0 + min(20), kind: 'transition', sessionId: 'wrk1', to: 'implement', via: 'approve_plan' },
    { line: 2, ts: T0 + min(30), kind: 'transition', sessionId: 'wrk2', to: 'review', via: 'send_prompt', forwardSessionId: 'wrk1' },
  ] });
  const t = links.filter((l) => l.type !== 'spawn');
  assert.deepEqual(t.map((l) => [l.type, l.from, l.to]), [['approve_plan', 'cond', 'wrk1'], ['forward', 'wrk1', 'wrk2']]);
});

test('cutoff: backfill before is kept, at/after dropped; ledger events always kept; no cutoff keeps all', () => {
  const calls = [call({ id: 'a', ts: T0 + min(10) }), call({ id: 'b', ts: T0 + min(50) }), call({ id: 'c', ts: T0 + min(60) })];
  const cut = T0 + min(50);
  const r = run({ backfill: { calls, wakes: [] }, cutoffTs: cut, ledger: [lev({ ts: T0 + min(70) })] });
  const inter = r.links.filter((l) => l.type === 'send_prompt');
  assert.deepEqual(inter.map((l) => [l.source, l.ts]), [['backfill', T0 + min(10)], ['ledger', T0 + min(70)]]);
  assert.equal(run({ backfill: { calls, wakes: [] }, cutoffTs: null }).links.filter((l) => l.source === 'backfill').length, 3);
});

test('a backfill call matching a transition within ±120 s draws one link only', () => {
  const trans = { line: 1, ts: T0 + min(20), kind: 'transition', sessionId: 'wrk1', to: 'implement', via: 'approve_plan' };
  const r = run({ ledger: [trans], backfill: { calls: [call({ tool: 'approve_plan', ts: T0 + min(20) + 90_000 })], wakes: [] } });
  assert.equal(r.links.filter((l) => l.type === 'approve_plan').length, 1);
  const far = run({ ledger: [trans], backfill: { calls: [call({ tool: 'approve_plan', ts: T0 + min(20) + 130_000 })], wakes: [] } });
  assert.equal(far.links.filter((l) => l.type === 'approve_plan').length, 2);
});

test('a ledger interaction matching a transition draws one link only; matching is one-to-one nearest first', () => {
  const trans = (line, ts) => ({ line, ts, kind: 'transition', sessionId: 'wrk1', to: 'x', via: 'send_prompt' });
  const r = run({
    ledger: [trans(1, T0 + min(20)), lev({ ts: T0 + min(20) + 5000 }), lev({ ts: T0 + min(21) })],
  });
  // two interactions, one transition: the nearest interaction is the transition; the other stays
  assert.equal(r.links.filter((l) => l.type === 'send_prompt').length, 2);
  assert.equal(r.links.filter((l) => l.type === 'send_prompt' && l.ts === T0 + min(20)).length, 1);
});

test('forward: type forward, from the forward source to the target (backfill and ledger)', () => {
  const r = run({
    backfill: { calls: [call({ forward: 'wrk2' })], wakes: [] },
    ledger: [lev({ forwardSessionId: 'wrk2', ts: T0 + min(99) })],
  });
  const f = r.links.filter((l) => l.type === 'forward');
  assert.deepEqual(f.map((l) => [l.from, l.to]), [['wrk2', 'wrk1'], ['wrk2', 'wrk1']]);
});

test('wake: worker → conductor, heartbeat kept (ledger and backfill)', () => {
  const r = run({
    ledger: [{ line: 3, ts: T0 + min(40), kind: 'wake', sessionId: 'wrk1', conductorSessionId: 'cond', heartbeat: true }],
    backfill: { calls: [], wakes: [{ key: 'u#0', ts: T0 + min(8), worker: 'wrk2', owner: 'cond' }] },
  });
  const w = r.links.filter((l) => l.type === 'wake');
  assert.deepEqual(w.map((l) => [l.from, l.to, l.heartbeat ?? false, l.source]), [['wrk2', 'cond', false, 'backfill'], ['wrk1', 'cond', true, 'ledger']]);
});

test('refused backfill calls make no link', () => {
  const r = run({ backfill: { calls: [call({ ok: false })], wakes: [] } });
  assert.equal(r.links.filter((l) => l.type === 'send_prompt').length, 0);
});

test('an unresolvable id drops the link and increments unresolved', () => {
  const r = run({ backfill: { calls: [call({ target: 'nope-nothing' })], wakes: [{ key: 'k', ts: T0, worker: 'ghost', owner: 'cond' }] } });
  assert.equal(r.links.filter((l) => l.source === 'backfill').length, 0);
  assert.equal(r.unresolved, 2);
});

test('parity: every governed tool gets the same link type from the ledger and from the backfill', () => {
  for (const tool of GOVERNED_TOOLS) {
    const fromLedger = run({ ledger: [lev({ tool })] }).links.filter((l) => l.source === 'ledger' && l.type !== 'spawn');
    const fromBackfill = run({ backfill: { calls: [call({ tool })], wakes: [] } }).links.filter((l) => l.source === 'backfill');
    assert.deepEqual(fromLedger.map((l) => l.type), [tool], tool);
    assert.deepEqual(fromBackfill.map((l) => l.type), [tool], tool);
  }
});

test('a ledger interaction with an unknown tool renders as type other and is counted, not dropped', () => {
  const r = run({ ledger: [lev({ tool: 'frobnicate' }), lev({ tool: 'frobnicate', ts: T0 + min(11) }), lev({ tool: 'mystery', ts: T0 + min(12) })] });
  assert.deepEqual(r.links.filter((l) => l.type === 'other').map((l) => [l.from, l.to]), [['cond', 'wrk1'], ['cond', 'wrk1'], ['cond', 'wrk1']]);
  assert.deepEqual(r.unknownTools, { frobnicate: 2, mystery: 1 });
});
