import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurns } from '../../src/model/turns.js';
import { evSession, evTurn, SYSTEM, T0, min } from '../helpers/store.mjs';

const idOf = (raw) => ({ a: 'A', 'a-backing': 'A', b: 'B' })[raw];
const rows = (...evs) => evs.map((e) => ({ ...e, ts: Date.parse(e.ts), ...(e.event ? { event: e.event } : {}) }));
const turn = (m, who, event) => evTurn(T0 + min(m), SYSTEM, who, event);
const sess = (m, who, event) => evSession(T0 + min(m), SYSTEM, who, event);
const fold = (...evs) => Object.fromEntries(buildTurns(rows(...evs), idOf));

test('start/end pairs fold per subject; interleaved subjects stay separate', () => {
  assert.deepEqual(fold(turn(1, 'a', 'start'), turn(2, 'b', 'start'), turn(3, 'a', 'end'), turn(5, 'b', 'end'), turn(6, 'a', 'start'), turn(7, 'a', 'end')),
    { A: [[T0 + min(1), T0 + min(3)], [T0 + min(6), T0 + min(7)]], B: [[T0 + min(2), T0 + min(5)]] });
});

test('an end with no open start is ignored', () => {
  assert.deepEqual(fold(turn(1, 'a', 'end'), turn(2, 'a', 'start'), turn(3, 'a', 'end')), { A: [[T0 + min(2), T0 + min(3)]] });
});

test('a second start closes the first turn at the new start', () => {
  assert.deepEqual(fold(turn(1, 'a', 'start'), turn(4, 'a', 'start'), turn(6, 'a', 'end')), { A: [[T0 + min(1), T0 + min(4)], [T0 + min(4), T0 + min(6)]] });
});

test('an open turn is closed by its own subject\'s session row, never by another subject\'s rows', () => {
  assert.deepEqual(fold(turn(1, 'a', 'start'), sess(2, 'b', 'exit'), turn(3, 'b', 'start'), sess(4, 'a', 'exit')),
    { A: [[T0 + min(1), T0 + min(4)]], B: [[T0 + min(3), null]] });
  assert.deepEqual(fold(turn(1, 'a', 'start'), sess(5, 'a', 'resume')), { A: [[T0 + min(1), T0 + min(5)]] });
});

test('a turn still open at the end of the log is [start, null]', () => {
  assert.deepEqual(fold(turn(1, 'a', 'start')), { A: [[T0 + min(1), null]] });
});

test('a subject given as a backing id maps to the public id; an unresolvable subject is dropped', () => {
  assert.deepEqual(fold(turn(1, 'a-backing', 'start'), turn(2, 'a', 'end'), turn(3, 'ghost', 'start'), turn(4, 'ghost', 'end')), { A: [[T0 + min(1), T0 + min(2)]] });
});
