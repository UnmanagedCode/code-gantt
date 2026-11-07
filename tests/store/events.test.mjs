import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeStore, evCall, evSession, evTurn, evWake, evConfig, SYSTEM, T0, min } from '../helpers/store.mjs';
import { EventLogReader } from '../../src/store/events.js';

const read = async (events) => {
  const s = makeStore({ events });
  const r = new EventLogReader(s.files.events);
  await r.refresh();
  return { s, r };
};

test('rows keep line order even when ts regresses', async () => {
  const { s, r } = await read([
    evSession(T0 + min(5), SYSTEM, 'a', 'start'),
    evSession(T0 + min(1), SYSTEM, 'a', 'exit'),
    evSession(T0 + min(3), SYSTEM, 'a', 'resume'),
  ]);
  assert.deepEqual(r.events.map((e) => e.event), ['start', 'exit', 'resume']);
  s.cleanup();
});

test('the envelope is parsed; a refused spawn_instance row with no subject is kept without one', async () => {
  const { s, r } = await read([
    evCall(T0, 'c1', 'w1', 'send_prompt', { forward: 'f1', move: { from: 'plan', to: 'impl' } }),
    evCall(T0 + 1, 'c1', undefined, 'spawn_instance', { outcome: 'refused', refusal: { code: 'x', reason: 'y' } }),
  ]);
  const [a, b] = r.events;
  assert.deepEqual([a.actor, a.subject, a.tool, a.outcome, a.forward, a.move], [{ type: 'conductor', sessionId: 'c1' }, 'w1', 'send_prompt', 'ok', 'f1', { from: 'plan', to: 'impl' }]);
  assert.equal(b.subject, undefined);
  assert.deepEqual([b.tool, b.outcome], ['spawn_instance', 'refused']);
  s.cleanup();
});

test('tolerant reader: unknown kind counted, unknown fields not copied, config read but not counted, non-objects skipped, bad types dropped', async () => {
  const s = makeStore({ events: [
    { v: 1, ts: '2026-11-01T00:00:00.000Z', kind: 'hologram', actor: SYSTEM },
    { ...evSession(T0, SYSTEM, 'a', 'exit', { cause: 'crashed' }), brandNew: 1 },
    evConfig(T0, 'a', 'warn'),
    evCall(T0, 'c', 'a', 'send_prompt', { move: 'nope', bind: { playbook: 'p' }, forward: 7 }),
  ] });
  s.append(s.files.events, '42\n[1]\n"str"\n');
  const r = new EventLogReader(s.files.events);
  await r.refresh();
  assert.deepEqual(r.events.map((e) => e.kind), ['session', 'call']);
  assert.equal('brandNew' in r.events[0], false);
  assert.equal(r.events[0].cause, 'crashed');
  const call = r.events[1];
  assert.deepEqual([call.move, call.bind, call.forward], [undefined, undefined, undefined]);
  assert.deepEqual(r.unknownKinds, { hologram: 1 });
  s.cleanup();
});

test('a row with another v is skipped and counted in otherVersionRows, not as an unknown kind', async () => {
  const { s, r } = await read([
    { ...evSession(T0, SYSTEM, 'a', 'exit'), v: 2 },
    { ...evSession(T0, SYSTEM, 'a', 'exit'), v: undefined },
    evSession(T0, SYSTEM, 'a', 'start'),
  ]);
  assert.equal(r.events.length, 1);
  assert.equal(r.otherVersionRows, 2);
  assert.deepEqual(r.unknownKinds, {});
  s.cleanup();
});

test('torn tail: nothing added until the line completes, then exactly that row', async () => {
  const { s, r } = await read([evSession(T0, SYSTEM, 'a', 'start')]);
  s.appendTorn(s.files.events, '{"v":1,"ts":"2026-11-01T00:00:00.000Z","kind":"session","actor":{"type":"system"},"subject":"a","ev');
  assert.equal((await r.refresh()).length, 0);
  s.append(s.files.events, 'ent":"exit"}\n');
  const added = await r.refresh();
  assert.deepEqual(added.map((e) => e.event), ['exit']);
  assert.equal(r.events.length, 2);
  s.cleanup();
});

test('a corrupt non-trailing line is counted; a missing file is empty with missing set', async () => {
  const s = makeStore({ events: [evSession(T0, SYSTEM, 'a', 'start')] });
  fs.appendFileSync(s.files.events, 'garbage\n');
  s.appendEvents(evSession(T0, SYSTEM, 'a', 'exit'));
  const r = new EventLogReader(s.files.events);
  await r.refresh();
  assert.equal(r.events.length, 2);
  assert.equal(r.corruptLines, 1);
  const m = new EventLogReader('/nonexistent-xyz/e.jsonl');
  await m.refresh();
  assert.equal(m.missing, true);
  assert.deepEqual(m.events, []);
  s.cleanup();
});

test('concurrent refresh() calls on a one-line file yield exactly one row', async () => {
  const s = makeStore({ events: [evSession(T0, SYSTEM, 'a', 'start')] });
  const r = new EventLogReader(s.files.events);
  const added = await Promise.all([r.refresh(), r.refresh(), r.refresh()]);
  assert.equal(r.events.length, 1);
  assert.equal(added.flat().length, 1);
  s.cleanup();
});

test('cutoffTs is the first wake or first call naming its caller; unattributed calls never set it', async () => {
  const unattributed = evCall(T0, { type: 'conductor' }, 'w', 'send_prompt');
  const { s, r } = await read([unattributed, evSession(T0 + min(1), SYSTEM, 'w', 'start'), evCall(T0 + min(2), 'c', 'w', 'send_prompt'), evWake(T0 + min(3), 'w', 'c')]);
  assert.equal(r.cutoffTs, T0 + min(2));
  const w = await read([unattributed, evWake(T0 + min(3), 'w', 'c'), evCall(T0 + min(4), 'c', 'w', 'send_prompt')]);
  assert.equal(w.r.cutoffTs, T0 + min(3));
  const n = await read([unattributed, evSession(T0, SYSTEM, 'w', 'start')]);
  assert.equal(n.r.cutoffTs, null);
  s.cleanup(); w.s.cleanup(); n.s.cleanup();
});

test('turnCutoffTs is the first turn row, null when none', async () => {
  const { s, r } = await read([evSession(T0, SYSTEM, 'w', 'start'), evTurn(T0 + min(4), 'c', 'w', 'start'), evTurn(T0 + min(5), SYSTEM, 'w', 'end')]);
  assert.equal(r.turnCutoffTs, T0 + min(4));
  const n = await read([evSession(T0, SYSTEM, 'w', 'start')]);
  assert.equal(n.r.turnCutoffTs, null);
  s.cleanup(); n.s.cleanup();
});

test('unknown kinds named like Object.prototype members are counted as plain keys', async () => {
  const mk = (kind) => ({ v: 1, ts: '2026-11-01T00:00:00.000Z', kind, actor: SYSTEM });
  const { s, r } = await read([mk('constructor'), mk('toString'), mk('constructor'), mk('__proto__')]);
  assert.deepEqual(Object.entries(r.unknownKinds).sort(), [['__proto__', 1], ['constructor', 2], ['toString', 1]]);
  s.cleanup();
});

test('truncation clears rows and every counter, corruptLines included', async () => {
  const s = makeStore({ events: [evWake(T0, 'w', 'c'), evTurn(T0, 'c', 'w', 'start'), { v: 9, kind: 'x' }, { v: 1, kind: 'zzz' }] });
  fs.appendFileSync(s.files.events, 'garbage\n');
  s.appendEvents(evSession(T0, SYSTEM, 'w', 'start'));
  const r = new EventLogReader(s.files.events);
  await r.refresh();
  assert.equal(r.events.length, 3);
  assert.equal(r.corruptLines, 1);
  fs.writeFileSync(s.files.events, JSON.stringify(evSession(T0, SYSTEM, 'w', 'start')) + '\n');
  await r.refresh();
  assert.deepEqual(r.events.map((e) => e.kind), ['session']);
  assert.deepEqual([r.cutoffTs, r.turnCutoffTs, r.otherVersionRows, r.unknownKinds, r.corruptLines], [null, null, 0, {}, 0]);
  s.cleanup();
});

test('wake.heartbeat and the full bind {playbook, stage} are copied from raw contract rows; other bind fields are not', async () => {
  const { s, r } = await read([
    evWake(T0, 'w', 'c', { heartbeat: true }),
    evWake(T0 + 1, 'w', 'c'),
    evCall(T0 + 2, 'c', 'w', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan', provenance: { stage: 'x' }, project: 'p', worktree: 'wt' } }),
  ]);
  const [hb, plain, spawn] = r.events;
  assert.deepEqual([hb.heartbeat, plain.heartbeat, hb.recipient], [true, undefined, 'c']);
  assert.deepEqual(spawn.bind, { playbook: 'classic', stage: 'plan' });
  s.cleanup();
});
