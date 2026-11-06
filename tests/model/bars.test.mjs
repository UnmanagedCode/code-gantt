import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBar } from '../../src/model/bars.js';
import { sess, iso, T0, min } from '../helpers/store.mjs';

const rec = (over = {}) => ({ id: 'w', ...sess({ id: 'w', parent: 'c', project: 'p', conducted: true, ...over }) });
const base = { own: [], namedMaxTs: 0, turns: [], turnRows: 0, linkTs: 0, kills: [], live: false, now: T0 + min(1000) };
const bar = (r, ctx) => buildBar(r, { ...base, ...ctx });
const ev = (kind, ts, o = {}) => ({ kind, ts, line: 0, ...o });

test('start is segments[0].at', () => {
  assert.equal(bar(rec({ at: iso(T0 + min(3)) }), {}).start, T0 + min(3));
});

test('retire → retired with endReason', () => {
  const b = bar(rec(), { own: [ev('retire', T0 + min(30), { reason: 'subprocess exited' })] });
  assert.deepEqual([b.endKind, b.end, b.endReason], ['retired', T0 + min(30), 'subprocess exited']);
});

test('retire then resume, and live → live with end null', () => {
  const b = bar(rec(), { own: [ev('retire', T0 + min(30), { reason: 'r' }), ev('resume', T0 + min(40))], live: true });
  assert.deepEqual([b.endKind, b.end], ['live', null]);
  assert.deepEqual(b.marks, [{ at: T0 + min(30), kind: 'retire' }, { at: T0 + min(40), kind: 'resume' }]);
});

test('a kill without a retire → killed at the kill ts', () => {
  const b = bar(rec(), { kills: [T0 + min(50)] });
  assert.deepEqual([b.endKind, b.end], ['killed', T0 + min(50)]);
});

test('a retire that follows a kill → killed, end stays the retire ts; a kill before a resume does not count', () => {
  const b = bar(rec(), { kills: [T0 + min(50)], own: [ev('retire', T0 + min(51), { reason: 'killed' })] });
  assert.deepEqual([b.endKind, b.end, b.endReason], ['killed', T0 + min(51), 'killed']);
  const c = bar(rec(), { kills: [T0 + min(50)], own: [ev('resume', T0 + min(60))], live: true });
  assert.equal(c.endKind, 'live');
});

test('not live and nothing else → approx, end = latest of turn end, ledger mention, link, segment', () => {
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

test('turns come from costs; turnCount is turnEndSeq else the row count', () => {
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

test('stage bands come from spawn and transitions labelled via; the last band ends at the bar end', () => {
  const own = [
    ev('spawn', T0, { stage: 'plan', playbook: 'classic' }),
    ev('transition', T0 + min(10), { to: 'implement', via: 'approve_plan' }),
    ev('transition', T0 + min(20), { to: 'review', via: 'send_prompt' }),
    ev('retire', T0 + min(30), { reason: 'done' }),
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
