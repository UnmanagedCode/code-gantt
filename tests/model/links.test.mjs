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

test('C3: a backfilled call straddling the cutoff is dropped in favour of its ledger twin; a distinct call stays', () => {
  const cut = T0 + min(50);
  const r = run({
    cutoffTs: cut,
    ledger: [lev({ ts: cut })],
    backfill: { calls: [call({ id: 'twin', ts: cut - 4000 }), call({ id: 'distinct', ts: cut - min(30) })], wakes: [] },
  });
  const sp = r.links.filter((l) => l.type === 'send_prompt');
  assert.deepEqual(sp.map((l) => [l.source, l.ts]), [['backfill', cut - min(30)], ['ledger', cut]]);
});

test('C3: a backfilled wake straddling the cutoff is dropped in favour of its ledger twin; wakes of other workers stay', () => {
  const cut = T0 + min(50);
  const r = run({
    cutoffTs: cut,
    ledger: [{ line: 1, ts: cut, kind: 'wake', sessionId: 'wrk1', conductorSessionId: 'cond' }],
    backfill: { calls: [], wakes: [
      { key: 'a#0', ts: cut - 3000, worker: 'wrk1', owner: 'cond' },
      { key: 'b#0', ts: cut - 3000, worker: 'wrk2', owner: 'cond' },
    ] },
  });
  const w = r.links.filter((l) => l.type === 'wake');
  assert.deepEqual(w.map((l) => [l.from, l.source]).sort(), [['wrk1', 'ledger'], ['wrk2', 'backfill']]);
});

test('C3: boundary matching is one-to-one, nearest first: of two backfilled calls near one ledger interaction the nearer is its twin and the other stays', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut })],
    backfill: { calls: [call({ id: 'a', ts: cut - 2000 }), call({ id: 'b', ts: cut - 9000 })], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => [l.source, l.ts]), [['backfill', cut - 9000], ['ledger', cut]]);
});

test('C3: matching requires the same type and endpoints', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut })],
    backfill: { calls: [call({ id: 'a', ts: cut - 2000, tool: 'approve_plan' }), call({ id: 'b', ts: cut - 2000, target: 'wrk2' })], wakes: [] } });
  assert.equal(r.links.filter((l) => l.source === 'backfill').length, 2);
});

test('S2: a cached call tool outside the governed set is typed other, never passed through', () => {
  const r = run({ backfill: { calls: [call({ tool: '<img src=x onerror=alert(1)>' })], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.source === 'backfill').map((l) => l.type), ['other']);
});

test('R5: tool names like Object.prototype members are typed other and counted exactly (no NaN or inherited counts)', () => {
  const r = run({
    ledger: [lev({ tool: 'constructor' }), lev({ tool: 'toString', ts: T0 + min(11) }), lev({ tool: 'constructor', ts: T0 + min(12) })],
    backfill: { calls: [call({ tool: 'hasOwnProperty', ts: T0 + min(13) })], wakes: [] },
  });
  assert.deepEqual(Object.entries(r.unknownTools).sort(), [['constructor', 2], ['hasOwnProperty', 1], ['toString', 1]]);
  assert.equal(r.links.filter((l) => l.type === 'other').length, 4);
});

test('R2: a genuine backfill call far before the cutoff is never eaten by ledger events that merely sit within 120 s', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut }), lev({ ts: cut + 10_000 })],
    backfill: { calls: [call({ id: 'genuine', ts: cut - 100_000 })], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => [l.source, l.ts]),
    [['backfill', cut - 100_000], ['ledger', cut], ['ledger', cut + 10_000]]);
});

test('R2: only a backfill event just before the cutoff pairs with a ledger event just after it; a later ledger event cannot twin it', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut }), lev({ ts: cut + 20_000 })],
    backfill: { calls: [call({ id: 'twin', ts: cut - 3000 })], wakes: [] } });
  // the twin is dropped against the ledger event at the cutoff, nothing else is lost
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => l.source), ['ledger', 'ledger']);
  const wide = run({ cutoffTs: cut, ledger: [lev({ ts: cut })], backfill: { calls: [call({ id: 'early', ts: cut - 60_000 })], wakes: [] } });
  assert.equal(wide.links.filter((l) => l.source === 'backfill').length, 1, 'a call a minute before the cutoff is not a twin');
});

// F2: a backfilled call's `ts` is its assistant tool_use line (before the handler runs, possibly minutes
// before for a parked send_prompt); `rts` is its tool_result line, written after the handler like the
// ledger entry. Cutoff and twin matching use rts.
test('F2: a twin whose tool_use is 40 s before the cutoff but whose result lands after it renders once', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut })], backfill: { calls: [call({ ts: cut - 40_000, rts: cut + 1000 })], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => l.source), ['ledger']);
});

test('F2: a twin parked for several minutes (tool_use 5 min before, result at the cutoff) renders once', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut })], backfill: { calls: [call({ ts: cut - min(5), rts: cut + 2000 })], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => l.source), ['ledger']);
});

test('F2: a genuine call that completed 100 s before the cutoff is kept, with or without rts', () => {
  const cut = T0 + min(50);
  for (const extra of [{}, { rts: cut - 99_000 }]) {
    const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut }), lev({ ts: cut + 10_000 })], backfill: { calls: [call({ ts: cut - 100_000, ...extra })], wakes: [] } });
    assert.equal(r.links.filter((l) => l.source === 'backfill').length, 1, JSON.stringify(extra));
  }
});

test('G1: with result times known the cutoff rule is exact: a genuine same-key call at cut-1s and a twin completing at cut+9s are 2 links, not 1', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut })], backfill: { calls: [
    call({ id: 'genuine', ts: cut - 3000, rts: cut - 1000 }),
    call({ id: 'twin', ts: cut - 20_000, rts: cut + 9000 }),
  ], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => [l.source, l.ts]), [['backfill', cut - 3000], ['ledger', cut]]);
});

test('F2: a genuine call shortly before the cutoff is not eaten by an unrelated ledger interaction (other tool or target)', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut,
    ledger: [lev({ ts: cut, tool: 'approve_plan' }), lev({ ts: cut + 1000, sessionId: 'wrk2' })],
    backfill: { calls: [call({ ts: cut - 6000, rts: cut - 5000 })], wakes: [] } });
  assert.equal(r.links.filter((l) => l.source === 'backfill').length, 1);
});

test('F2: a call whose result landed at or after the cutoff belongs to the ledger even with no twin to pair', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut, sessionId: 'wrk2' })], backfill: { calls: [call({ ts: cut - 10_000, rts: cut + 5000 })], wakes: [] } });
  assert.equal(r.links.filter((l) => l.source === 'backfill').length, 0);
});

test('F2: transition dedupe also uses the result time, so a parked stage-moving call still draws one link', () => {
  const t = T0 + min(20);
  const trans = { line: 1, ts: t, kind: 'transition', sessionId: 'wrk1', to: 'implement', via: 'approve_plan' };
  const r = run({ ledger: [trans], backfill: { calls: [call({ tool: 'approve_plan', ts: t - min(5), rts: t + 500 })], wakes: [] } });
  assert.equal(r.links.filter((l) => l.type === 'approve_plan').length, 1);
});

test('F2 (wakes): a wake straddling the cutoff by a small skew is deduped; one a minute earlier is kept (wakes have no result time)', () => {
  const cut = T0 + min(50);
  const ledger = [{ line: 1, ts: cut, kind: 'wake', sessionId: 'wrk1', conductorSessionId: 'cond' }];
  const r = run({ cutoffTs: cut, ledger, backfill: { calls: [], wakes: [
    { key: 'a#0', ts: cut - 2000, worker: 'wrk1', owner: 'cond' },
    { key: 'b#0', ts: cut - 60_000, worker: 'wrk1', owner: 'cond' },
  ] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'wake').map((l) => [l.source, l.ts]), [['backfill', cut - 60_000], ['ledger', cut]]);
});

test('G2: an unresolvable id on a post-cutoff call counts once (its ledger counterpart), not twice', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut,
    ledger: [lev({ ts: cut, sessionId: 'ghost0000' })],
    backfill: { calls: [call({ target: 'ghost0000', ts: cut - 2000, rts: cut + 1000 })], wakes: [] } });
  assert.equal(r.unresolved, 1);
});

test('G2: an unresolvable id on a pre-cutoff call still counts (it is real data that cannot be placed)', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut })],
    backfill: { calls: [call({ target: 'ghost0000', ts: cut - min(10), rts: cut - min(10) + 1000 })], wakes: [] } });
  assert.equal(r.unresolved, 1);
});

test('H1: wake pairing is bounded by the ledger twins near the cutoff: two ledger wakes may take two genuine pre-cutoff wakes, never more', () => {
  const cut = T0 + min(50);
  const ledger = [cut, cut + 20_000].map((ts, line) => ({ line, ts, kind: 'wake', sessionId: 'wrk1', conductorSessionId: 'cond' }));
  const r = run({ cutoffTs: cut, ledger, backfill: { calls: [], wakes: [5000, 10_000, 15_000].map((d, i) => ({ key: `k#${i}`, ts: cut - d, worker: 'wrk1', owner: 'cond' })) } });
  const bf = r.links.filter((l) => l.type === 'wake' && l.source === 'backfill');
  assert.equal(bf.length, 1, 'three genuine-looking wakes, two ledger twins: two are taken, one survives');
  assert.equal(bf[0].ts, cut - 15_000, 'the nearest pair first: the farthest is the one left');
  assert.equal(r.links.filter((l) => l.type === 'wake' && l.source === 'ledger').length, 2);
});

test('H2: a call without a result time that is paired with its ledger twin counts its unresolvable id once, not twice', () => {
  const cut = T0 + min(50);
  const { rts, ...parked } = call({ target: 'ghost0000', ts: cut - 2000 });
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut, sessionId: 'ghost0000' })], backfill: { calls: [parked], wakes: [] } });
  assert.equal(r.unresolved, 1);
});

test('H2: an unresolvable rts-less call with no ledger twin still counts (it is real data that cannot be placed)', () => {
  const cut = T0 + min(50);
  const { rts, ...parked } = call({ target: 'ghost0001', ts: cut - 2000 });
  const r = run({ cutoffTs: cut, ledger: [lev({ ts: cut, sessionId: 'ghost0000' })], backfill: { calls: [parked], wakes: [] } });
  assert.equal(r.unresolved, 2);
});

test('H2: an unresolvable wake paired with its ledger wake counts once', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut,
    ledger: [{ line: 1, ts: cut, kind: 'wake', sessionId: 'ghost0000', conductorSessionId: 'cond' }],
    backfill: { calls: [], wakes: [{ key: 'a#0', ts: cut - 2000, worker: 'ghost0000', owner: 'cond' }] } });
  assert.equal(r.unresolved, 1);
});
