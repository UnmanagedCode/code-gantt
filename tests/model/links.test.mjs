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
  return buildLinks({ sessions, events: [], backfill: { calls: [], wakes: [] }, cutoffTs: null, ...over });
};
const call = (o) => ({ id: 'toolu_' + Math.random(), ts: T0 + min(10), tool: 'send_prompt', target: 'wrk1', owner: 'cond', ok: true, ...o });
// normalised EventLogReader rows
const lev = ({ ts = T0 + min(10), caller = 'cond', subject = 'wrk1', tool = 'send_prompt', ...rest } = {}) =>
  ({ ts, kind: 'call', actor: caller ? { type: 'conductor', sessionId: caller } : { type: 'conductor' }, subject, tool, outcome: 'ok', ...rest });
const wk = (ts, subject, recipient, rest = {}) => ({ ts, kind: 'wake', actor: { type: 'system' }, subject, recipient, ...rest });

test('spawn: parent → child at the child start, from sessions.json', () => {
  const { links } = run();
  const sp = links.filter((l) => l.type === 'spawn');
  assert.deepEqual(sp.map((l) => [l.from, l.to, l.ts]), [['cond', 'wrk1', T0 + min(5)], ['cond', 'wrk2', T0 + min(6)]]);
});

test('an attributed ok call draws caller → subject typed by its tool, source store', () => {
  const r = run({ events: [lev({ tool: 'approve_plan' })] });
  assert.deepEqual(r.links.filter((l) => l.type !== 'spawn').map((l) => [l.type, l.from, l.to, l.source]), [['approve_plan', 'cond', 'wrk1', 'store']]);
});

test('a call with forward draws a forward link from the forward id', () => {
  const r = run({ events: [lev({ forward: 'wrk2' })] });
  assert.deepEqual(r.links.filter((l) => l.type !== 'spawn').map((l) => [l.type, l.from, l.to]), [['forward', 'wrk2', 'wrk1']]);
});

test('refused and failed calls draw no link', () => {
  const r = run({ events: [lev({ outcome: 'refused' }), lev({ outcome: 'failed', ts: T0 + min(11) })] });
  assert.deepEqual(r.links.filter((l) => l.type !== 'spawn'), []);
});

test('a spawn_instance call draws no extra link: spawn edges come from sessions.json only', () => {
  const r = run({ events: [lev({ tool: 'spawn_instance' })] });
  assert.equal(r.links.filter((l) => l.type === 'spawn').length, 2);
  assert.equal(r.links.length, 2);
  assert.deepEqual(r.unknownTools, {});
});

test('an unattributed (migrated) call draws nothing and counts nothing, with or without forward; no caller is inferred', () => {
  const r = run({ events: [lev({ caller: null }), lev({ caller: null, forward: 'ghost0000', ts: T0 + min(11) })] });
  assert.deepEqual(r.links.filter((l) => l.type !== 'spawn'), []);
  assert.equal(r.unresolved, 0);
});

test('a wake row draws worker → recipient and keeps heartbeat', () => {
  const r = run({ events: [wk(T0 + min(40), 'wrk1', 'cond', { heartbeat: true }), wk(T0 + min(41), 'wrk2', 'cond')] });
  assert.deepEqual(r.links.filter((l) => l.type === 'wake').map((l) => [l.from, l.to, l.heartbeat ?? false]), [['wrk1', 'cond', true], ['wrk2', 'cond', false]]);
});

test('cutoff: backfill before is kept, at/after dropped; event-log rows always kept; no cutoff keeps all', () => {
  const calls = [call({ id: 'a', ts: T0 + min(10) }), call({ id: 'b', ts: T0 + min(50) }), call({ id: 'c', ts: T0 + min(60) })];
  const cut = T0 + min(50);
  const r = run({ backfill: { calls, wakes: [] }, cutoffTs: cut, events: [lev({ ts: T0 + min(70) })] });
  const inter = r.links.filter((l) => l.type === 'send_prompt');
  assert.deepEqual(inter.map((l) => [l.source, l.ts]), [['backfill', T0 + min(10)], ['store', T0 + min(70)]]);
  assert.equal(run({ backfill: { calls, wakes: [] }, cutoffTs: null }).links.filter((l) => l.source === 'backfill').length, 3);
});

test('forward: type forward, from the forward source to the target (backfill and event log)', () => {
  const r = run({
    backfill: { calls: [call({ forward: 'wrk2' })], wakes: [] },
    events: [lev({ forward: 'wrk2', ts: T0 + min(99) })],
  });
  const f = r.links.filter((l) => l.type === 'forward');
  assert.deepEqual(f.map((l) => [l.from, l.to]), [['wrk2', 'wrk1'], ['wrk2', 'wrk1']]);
});

test('wake: worker → conductor, heartbeat kept (store and backfill)', () => {
  const r = run({
    events: [wk(T0 + min(40), 'wrk1', 'cond', { heartbeat: true })],
    backfill: { calls: [], wakes: [{ key: 'u#0', ts: T0 + min(8), worker: 'wrk2', owner: 'cond' }] },
  });
  const w = r.links.filter((l) => l.type === 'wake');
  assert.deepEqual(w.map((l) => [l.from, l.to, l.heartbeat ?? false, l.source]), [['wrk2', 'cond', false, 'backfill'], ['wrk1', 'cond', true, 'store']]);
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

test('parity: every governed tool gets the same link type from the event log and from the backfill', () => {
  for (const tool of GOVERNED_TOOLS) {
    const fromLog = run({ events: [lev({ tool })] }).links.filter((l) => l.source === 'store' && l.type !== 'spawn');
    const fromBackfill = run({ backfill: { calls: [call({ tool })], wakes: [] } }).links.filter((l) => l.source === 'backfill');
    assert.deepEqual(fromLog.map((l) => l.type), [tool], tool);
    assert.deepEqual(fromBackfill.map((l) => l.type), [tool], tool);
  }
});

test('an event-log call with an unknown tool renders as type other and is counted, not dropped', () => {
  const r = run({ events: [lev({ tool: 'frobnicate' }), lev({ tool: 'frobnicate', ts: T0 + min(11) }), lev({ tool: 'mystery', ts: T0 + min(12) })] });
  assert.deepEqual(r.links.filter((l) => l.type === 'other').map((l) => [l.from, l.to]), [['cond', 'wrk1'], ['cond', 'wrk1'], ['cond', 'wrk1']]);
  assert.deepEqual(r.unknownTools, { frobnicate: 2, mystery: 1 });
});

test('C3: a backfilled call straddling the cutoff is dropped in favour of its event-log twin; a distinct call stays', () => {
  const cut = T0 + min(50);
  const r = run({
    cutoffTs: cut,
    events: [lev({ ts: cut })],
    backfill: { calls: [call({ id: 'twin', ts: cut - 4000 }), call({ id: 'distinct', ts: cut - min(30) })], wakes: [] },
  });
  const sp = r.links.filter((l) => l.type === 'send_prompt');
  assert.deepEqual(sp.map((l) => [l.source, l.ts]), [['backfill', cut - min(30)], ['store', cut]]);
});

test('C3: a backfilled wake straddling the cutoff is dropped in favour of its event-log twin; wakes of other workers stay', () => {
  const cut = T0 + min(50);
  const r = run({
    cutoffTs: cut,
    events: [wk(cut, 'wrk1', 'cond')],
    backfill: { calls: [], wakes: [
      { key: 'a#0', ts: cut - 3000, worker: 'wrk1', owner: 'cond' },
      { key: 'b#0', ts: cut - 3000, worker: 'wrk2', owner: 'cond' },
    ] },
  });
  const w = r.links.filter((l) => l.type === 'wake');
  assert.deepEqual(w.map((l) => [l.from, l.source]).sort(), [['wrk1', 'store'], ['wrk2', 'backfill']]);
});

test('C3: boundary matching is one-to-one, nearest first: of two backfilled calls near one event-log call the nearer is its twin and the other stays', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut })],
    backfill: { calls: [call({ id: 'a', ts: cut - 2000 }), call({ id: 'b', ts: cut - 9000 })], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => [l.source, l.ts]), [['backfill', cut - 9000], ['store', cut]]);
});

test('C3: matching requires the same type and endpoints', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut })],
    backfill: { calls: [call({ id: 'a', ts: cut - 2000, tool: 'approve_plan' }), call({ id: 'b', ts: cut - 2000, target: 'wrk2' })], wakes: [] } });
  assert.equal(r.links.filter((l) => l.source === 'backfill').length, 2);
});

test('S2: a cached call tool outside the governed set is typed other, never passed through', () => {
  const r = run({ backfill: { calls: [call({ tool: '<img src=x onerror=alert(1)>' })], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.source === 'backfill').map((l) => l.type), ['other']);
});

test('R5: tool names like Object.prototype members are typed other and counted exactly (no NaN or inherited counts)', () => {
  const r = run({
    events: [lev({ tool: 'constructor' }), lev({ tool: 'toString', ts: T0 + min(11) }), lev({ tool: 'constructor', ts: T0 + min(12) })],
    backfill: { calls: [call({ tool: 'hasOwnProperty', ts: T0 + min(13) })], wakes: [] },
  });
  assert.deepEqual(Object.entries(r.unknownTools).sort(), [['constructor', 2], ['hasOwnProperty', 1], ['toString', 1]]);
  assert.equal(r.links.filter((l) => l.type === 'other').length, 4);
});

test('R2: a genuine backfill call far before the cutoff is never eaten by event-log rows that merely sit within 120 s', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut }), lev({ ts: cut + 10_000 })],
    backfill: { calls: [call({ id: 'genuine', ts: cut - 100_000 })], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => [l.source, l.ts]),
    [['backfill', cut - 100_000], ['store', cut], ['store', cut + 10_000]]);
});

test('R2: only a backfill event just before the cutoff pairs with an event-log event just after it; a later log event cannot twin it', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut }), lev({ ts: cut + 20_000 })],
    backfill: { calls: [call({ id: 'twin', ts: cut - 3000 })], wakes: [] } });
  // the twin is dropped against the event log event at the cutoff, nothing else is lost
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => l.source), ['store', 'store']);
  const wide = run({ cutoffTs: cut, events: [lev({ ts: cut })], backfill: { calls: [call({ id: 'early', ts: cut - 60_000 })], wakes: [] } });
  assert.equal(wide.links.filter((l) => l.source === 'backfill').length, 1, 'a call a minute before the cutoff is not a twin');
});

// F2: a backfilled call's `ts` is its assistant tool_use line (before the handler runs, possibly minutes
// before for a parked send_prompt); `rts` is its tool_result line, written after the handler like the
// event-log row. Cutoff and twin matching use rts.
test('F2: a twin whose tool_use is 40 s before the cutoff but whose result lands after it renders once', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut })], backfill: { calls: [call({ ts: cut - 40_000, rts: cut + 1000 })], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => l.source), ['store']);
});

test('F2: a twin parked for several minutes (tool_use 5 min before, result at the cutoff) renders once', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut })], backfill: { calls: [call({ ts: cut - min(5), rts: cut + 2000 })], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => l.source), ['store']);
});

test('F2: a genuine call that completed 100 s before the cutoff is kept, with or without rts', () => {
  const cut = T0 + min(50);
  for (const extra of [{}, { rts: cut - 99_000 }]) {
    const r = run({ cutoffTs: cut, events: [lev({ ts: cut }), lev({ ts: cut + 10_000 })], backfill: { calls: [call({ ts: cut - 100_000, ...extra })], wakes: [] } });
    assert.equal(r.links.filter((l) => l.source === 'backfill').length, 1, JSON.stringify(extra));
  }
});

test('G1: with result times known the cutoff rule is exact: a genuine same-key call at cut-1s and a twin completing at cut+9s are 2 links, not 1', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut })], backfill: { calls: [
    call({ id: 'genuine', ts: cut - 3000, rts: cut - 1000 }),
    call({ id: 'twin', ts: cut - 20_000, rts: cut + 9000 }),
  ], wakes: [] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'send_prompt').map((l) => [l.source, l.ts]), [['backfill', cut - 3000], ['store', cut]]);
});

test('F2: a genuine call shortly before the cutoff is not eaten by an unrelated event-log call (other tool or target)', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut,
    events: [lev({ ts: cut, tool: 'approve_plan' }), lev({ ts: cut + 1000, subject: 'wrk2' })],
    backfill: { calls: [call({ ts: cut - 6000, rts: cut - 5000 })], wakes: [] } });
  assert.equal(r.links.filter((l) => l.source === 'backfill').length, 1);
});

test('F2: a call whose result landed at or after the cutoff belongs to the event log even with no twin to pair', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut, subject: 'wrk2' })], backfill: { calls: [call({ ts: cut - 10_000, rts: cut + 5000 })], wakes: [] } });
  assert.equal(r.links.filter((l) => l.source === 'backfill').length, 0);
});

test('F2 (wakes): a wake straddling the cutoff by a small skew is deduped; one a minute earlier is kept (wakes have no result time)', () => {
  const cut = T0 + min(50);
  const log = [wk(cut, 'wrk1', 'cond')];
  const r = run({ cutoffTs: cut, events: log, backfill: { calls: [], wakes: [
    { key: 'a#0', ts: cut - 2000, worker: 'wrk1', owner: 'cond' },
    { key: 'b#0', ts: cut - 60_000, worker: 'wrk1', owner: 'cond' },
  ] } });
  assert.deepEqual(r.links.filter((l) => l.type === 'wake').map((l) => [l.source, l.ts]), [['backfill', cut - 60_000], ['store', cut]]);
});

test('G2: an unresolvable id on a post-cutoff call counts once (its event-log counterpart), not twice', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut,
    events: [lev({ ts: cut, subject: 'ghost0000' })],
    backfill: { calls: [call({ target: 'ghost0000', ts: cut - 2000, rts: cut + 1000 })], wakes: [] } });
  assert.equal(r.unresolved, 1);
});

test('G2: an unresolvable id on a pre-cutoff call still counts (it is real data that cannot be placed)', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut })],
    backfill: { calls: [call({ target: 'ghost0000', ts: cut - min(10), rts: cut - min(10) + 1000 })], wakes: [] } });
  assert.equal(r.unresolved, 1);
});

test('H1: wake pairing is bounded by the event-log twins near the cutoff: two event-log wakes may take two genuine pre-cutoff wakes, never more', () => {
  const cut = T0 + min(50);
  const log = [cut, cut + 20_000].map((ts) => wk(ts, 'wrk1', 'cond'));
  const r = run({ cutoffTs: cut, events: log, backfill: { calls: [], wakes: [5000, 10_000, 15_000].map((d, i) => ({ key: `k#${i}`, ts: cut - d, worker: 'wrk1', owner: 'cond' })) } });
  const bf = r.links.filter((l) => l.type === 'wake' && l.source === 'backfill');
  assert.equal(bf.length, 1, 'three genuine-looking wakes, two event-log twins: two are taken, one survives');
  assert.equal(bf[0].ts, cut - 15_000, 'the nearest pair first: the farthest is the one left');
  assert.equal(r.links.filter((l) => l.type === 'wake' && l.source === 'store').length, 2);
});

test('H2: a call without a result time that is paired with its event-log twin counts its unresolvable id once, not twice', () => {
  const cut = T0 + min(50);
  const { rts, ...parked } = call({ target: 'ghost0000', ts: cut - 2000 });
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut, subject: 'ghost0000' })], backfill: { calls: [parked], wakes: [] } });
  assert.equal(r.unresolved, 1);
});

test('H2: an unresolvable rts-less call with no event-log twin still counts (it is real data that cannot be placed)', () => {
  const cut = T0 + min(50);
  const { rts, ...parked } = call({ target: 'ghost0001', ts: cut - 2000 });
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut, subject: 'ghost0000' })], backfill: { calls: [parked], wakes: [] } });
  assert.equal(r.unresolved, 2);
});

test('H2: an unresolvable wake paired with its event-log wake counts once', () => {
  const cut = T0 + min(50);
  const r = run({ cutoffTs: cut,
    events: [wk(cut, 'ghost0000', 'cond')],
    backfill: { calls: [], wakes: [{ key: 'a#0', ts: cut - 2000, worker: 'ghost0000', owner: 'cond' }] } });
  assert.equal(r.unresolved, 1);
});

test('J1: only the id an event-log twin actually names is suppressed; an unresolvable owner no event-log row names still counts', () => {
  const cut = T0 + min(50);
  const { rts, ...parked } = call({ target: 'ghost0000', owner: 'ghostowner', ts: cut - 2000 });
  const r = run({ cutoffTs: cut, events: [lev({ ts: cut, subject: 'ghost0000' })], backfill: { calls: [parked], wakes: [] } });
  assert.equal(r.unresolved, 2, 'ghost0000 once (log), ghostowner once (backfill)');
});

test('J1: likewise for a forward id the twin does not name, and for a wake whose owner is unresolvable', () => {
  const cut = T0 + min(50);
  const { rts, ...parked } = call({ target: 'ghost0000', forward: 'ghostfwd', ts: cut - 2000 });
  const a = run({ cutoffTs: cut, events: [lev({ ts: cut, subject: 'ghost0000' })], backfill: { calls: [parked], wakes: [] } });
  assert.equal(a.unresolved, 2);
  const b = run({ cutoffTs: cut,
    events: [wk(cut, 'wrk1', 'cond')],
    backfill: { calls: [], wakes: [{ key: 'a#0', ts: cut - 2000, worker: 'wrk1', owner: 'ghostowner' }] } });
  assert.equal(b.unresolved, 1, 'the owner is named by no event-log row');
});
