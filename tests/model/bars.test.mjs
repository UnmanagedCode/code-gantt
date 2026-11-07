import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBar, KILL_AFTER_EXIT_MS } from '../../src/model/bars.js';
import { sess, iso, T0, min } from '../helpers/store.mjs';

const rec = (over = {}) => ({ id: 'w', ...sess({ id: 'w', parent: 'c', project: 'p', conducted: true, ...over }) });
const base = { own: [], namedMaxTs: 0, turns: [], turnRows: 0, linkTs: 0, kills: [], live: false, now: T0 + min(1000) };
const bar = (r, ctx) => buildBar(r, { ...base, ...ctx });
const SYS = { type: 'system' };
// normalised EventLogReader rows
const session = (event, ts, o = {}) => ({ kind: 'session', event, ts, actor: SYS, ...o });
const call = (tool, ts, o = {}) => ({ kind: 'call', tool, outcome: 'ok', ts, actor: { type: 'conductor', sessionId: 'c' }, ...o });

test('start is segments[0].at', () => {
  assert.equal(bar(rec({ at: iso(T0 + min(3)) }), {}).start, T0 + min(3));
});

test('a session exit → exited with endReason = cause', () => {
  const b = bar(rec(), { own: [session('exit', T0 + min(30), { cause: 'crashed' })] });
  assert.deepEqual([b.endKind, b.end, b.endReason], ['exited', T0 + min(30), 'crashed']);
});

test('exit then resume, and live → live with end null; the marks are exit and resume', () => {
  const b = bar(rec(), { own: [session('exit', T0 + min(30)), session('resume', T0 + min(40), { cause: 'restore' })], live: true });
  assert.deepEqual([b.endKind, b.end], ['live', null]);
  assert.deepEqual(b.marks, [{ at: T0 + min(30), kind: 'exit' }, { at: T0 + min(40), kind: 'resume' }]);
});

test('a kill link without an exit → killed at the kill ts', () => {
  const b = bar(rec(), { kills: [T0 + min(50)] });
  assert.deepEqual([b.endKind, b.end], ['killed', T0 + min(50)]);
});

test('an exit by a conductor or a human actor → killed with no kill link; a system exit is exited', () => {
  for (const type of ['conductor', 'human']) {
    const b = bar(rec(), { own: [session('exit', T0 + min(50), { actor: { type }, cause: 'exited' })] });
    assert.deepEqual([b.endKind, b.end], ['killed', T0 + min(50)], type);
  }
  assert.equal(bar(rec(), { own: [session('exit', T0 + min(50))] }).endKind, 'exited');
});

test('a system exit with a kill link within KILL_AFTER_EXIT_MS (either order) → killed, end = exit ts; later → exited', () => {
  const exit = session('exit', T0 + min(50));
  for (const dt of [7, -7, KILL_AFTER_EXIT_MS]) {
    const b = bar(rec(), { own: [exit], kills: [exit.ts + dt] });
    assert.deepEqual([b.endKind, b.end], ['killed', exit.ts], String(dt));
  }
  assert.equal(bar(rec(), { own: [exit], kills: [exit.ts + 60_000] }).endKind, 'exited');
});

test('a kill link before the last resume never counts', () => {
  const resumed = bar(rec(), { own: [session('exit', T0 + min(50)), session('resume', T0 + min(60)), session('exit', T0 + min(70))], kills: [T0 + min(50) + 5] });
  assert.equal(resumed.endKind, 'exited');
  assert.equal(bar(rec(), { kills: [T0 + min(50)], own: [session('resume', T0 + min(60))], live: true }).endKind, 'live');
});

test('not live and nothing else → approx, end = latest of turn end, event-log mention, link, segment', () => {
  const r = rec({ segments: [
    { id: 'a', reason: 'initial', at: iso(T0) }, { id: 'b', reason: 'renew', at: iso(T0 + min(10)) },
  ] });
  const cases = [
    [{ turns: [[T0, T0 + min(100)]] }, T0 + min(100)],
    [{ namedMaxTs: T0 + min(200) }, T0 + min(200)],
    [{ linkTs: T0 + min(300) }, T0 + min(300)],
    [{}, T0 + min(10)],
  ];
  for (const [ctx, want] of cases) {
    const b = bar(r, ctx);
    assert.deepEqual([b.endKind, b.end], ['approx', want], JSON.stringify(ctx));
  }
});

test('liveness unavailable (live=false) never produces live', () => {
  assert.equal(bar(rec(), { live: false }).endKind, 'approx');
});

test('turnCount is turnEndSeq else the row count', () => {
  assert.deepEqual(bar(rec(), { turns: [[1, 2]], turnRows: 5 }).turns, [[1, 2]]);
  assert.equal(bar(rec(), { turnRows: 5 }).turnCount, 5);
  assert.equal(bar(rec({ turnEndSeq: 9 }), { turnRows: 5 }).turnCount, 9);
});

test('rotation markers only for renew and prune after the first segment', () => {
  const r = rec({ segments: [
    { id: 'a', reason: 'initial', at: iso(T0) },
    { id: 'b', reason: 'renew', at: iso(T0 + min(5)) },
    { id: 'c', reason: 'prune', at: iso(T0 + min(6)) },
    { id: 'd', reason: 'mystery', at: iso(T0 + min(7)) },
  ] });
  assert.deepEqual(bar(r, {}).rotations, [{ at: T0 + min(5), reason: 'renew' }, { at: T0 + min(6), reason: 'prune' }]);
});

test('stage bands come from bind then moves labelled via the tool; the last band ends at the bar end', () => {
  const own = [
    call('spawn_instance', T0, { bind: { playbook: 'classic', stage: 'plan' } }),
    call('approve_plan', T0 + min(10), { move: { from: 'plan', to: 'implement' } }),
    call('send_prompt', T0 + min(20), { move: { from: 'implement', to: 'review' } }),
    session('exit', T0 + min(30), { cause: 'exited' }),
  ];
  const b = bar(rec(), { own });
  assert.equal(b.playbook, 'classic');
  assert.deepEqual(b.stages, [
    { stage: 'plan', from: T0, to: T0 + min(10) },
    { stage: 'implement', from: T0 + min(10), to: T0 + min(20), via: 'approve_plan' },
    { stage: 'review', from: T0 + min(20), to: T0 + min(30), via: 'send_prompt' },
  ]);
  const live = bar(rec(), { own: own.slice(0, 2), live: true });
  assert.equal(live.stages.at(-1).to, null);
});

test('a move to the stage already held folds nothing; a refused row carrying a move still folds', () => {
  const own = [
    call('spawn_instance', T0, { bind: { playbook: 'classic', stage: 'plan' } }),
    call('send_prompt', T0 + min(5), { move: { from: 'review', to: 'plan' } }),
    call('send_prompt', T0 + min(8), { outcome: 'refused', move: { from: 'plan', to: 'review' } }),
  ];
  assert.deepEqual(bar(rec(), { own }).stages.map((x) => x.stage), ['plan', 'review']);
});

test('a second bind replaces the bands and the playbook', () => {
  const own = [
    call('spawn_instance', T0, { bind: { playbook: 'classic', stage: 'plan' } }),
    call('approve_plan', T0 + min(5), { move: { from: 'plan', to: 'implement' } }),
    call('spawn_instance', T0 + min(9), { bind: { playbook: 'split', stage: 'draft' } }),
  ];
  const b = bar(rec(), { own, live: true });
  assert.equal(b.playbook, 'split');
  assert.deepEqual(b.stages, [{ stage: 'draft', from: T0 + min(9), to: null }]);
});
