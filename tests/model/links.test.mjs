import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinks } from '../../src/model/links.js';
import { buildForest } from '../../src/model/tree.js';
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
  return buildLinks({ sessions, events: [], ...over });
};
// normalised EventLogReader rows
const lev = ({ ts = T0 + min(10), caller = 'cond', subject = 'wrk1', tool = 'send_prompt', ...rest } = {}) =>
  ({ ts, kind: 'call', actor: caller ? { type: 'conductor', sessionId: caller } : { type: 'conductor' }, subject, tool, outcome: 'ok', ...rest });
const wk = (ts, subject, recipient, rest = {}) => ({ ts, kind: 'wake', actor: { type: 'system' }, subject, recipient, ...rest });

test('spawn: parent → child at the child start, from sessions.json', () => {
  const { links } = run();
  const sp = links.filter((l) => l.type === 'spawn');
  assert.deepEqual(sp.map((l) => [l.from, l.to, l.ts]), [['cond', 'wrk1', T0 + min(5)], ['cond', 'wrk2', T0 + min(6)]]);
});

test('an attributed ok call draws caller → subject typed by its tool', () => {
  const r = run({ events: [lev({ tool: 'approve_plan' })] });
  assert.deepEqual(r.links.filter((l) => l.type !== 'spawn').map((l) => [l.type, l.from, l.to]), [['approve_plan', 'cond', 'wrk1']]);
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

test('a link carries only ts, type and endpoints (plus heartbeat on wakes): no source', () => {
  const r = run({ events: [lev(), wk(T0 + min(40), 'wrk1', 'cond', { heartbeat: true })] });
  for (const l of r.links) assert.deepEqual(Object.keys(l).filter((k) => !['ts', 'type', 'from', 'to', 'heartbeat'].includes(k)), []);
});

test('an unresolvable id drops the link and increments unresolved, once per unplaceable id', () => {
  const r = run({ events: [lev({ subject: 'nope-nothing' }), wk(T0, 'ghost', 'cond')] });
  assert.deepEqual(r.links.filter((l) => l.type !== 'spawn'), []);
  assert.equal(r.unresolved, 2);
});

test('an event-log call with an unknown tool renders as type other and is counted, not dropped', () => {
  const r = run({ events: [lev({ tool: 'frobnicate' }), lev({ tool: 'frobnicate', ts: T0 + min(11) }), lev({ tool: 'mystery', ts: T0 + min(12) })] });
  assert.deepEqual(r.links.filter((l) => l.type === 'other').map((l) => [l.from, l.to]), [['cond', 'wrk1'], ['cond', 'wrk1'], ['cond', 'wrk1']]);
  assert.deepEqual(r.unknownTools, { frobnicate: 2, mystery: 1 });
});

test('tool names like Object.prototype members are typed other and counted exactly (no NaN or inherited counts)', () => {
  const r = run({ events: [lev({ tool: 'constructor' }), lev({ tool: 'toString', ts: T0 + min(11) }), lev({ tool: 'constructor', ts: T0 + min(12) })] });
  assert.deepEqual(Object.entries(r.unknownTools).sort(), [['constructor', 2], ['toString', 1]]);
  assert.equal(r.links.filter((l) => l.type === 'other').length, 3);
});
