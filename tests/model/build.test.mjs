import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, sess, iso, T0, min, evCall, evSession, evTurn, evWake, SYSTEM } from '../helpers/store.mjs';
import { PROMPT_SENTINEL as S } from '../helpers/sentinel.mjs';
import { createState } from '../../src/state.js';
import { buildPayload } from '../../src/model/build.js';
import { LINK_TYPES } from '../../src/model/linkTypes.js';

const call = (id, target) => ({
  type: 'assistant', timestamp: iso(T0 + min(15)), uuid: 'a' + id,
  message: { content: [{ type: 'tool_use', id, name: 'mcp__code-conductor__send_prompt', input: { sessionId: target, text: S } }] },
});
const result = (id) => ({ type: 'user', timestamp: iso(T0 + min(15)), uuid: 'r' + id, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify({ ok: true, note: S }) }] }] } });
const wake = { type: 'user', timestamp: iso(T0 + min(16)), uuid: 'wk', message: { content: [{ type: 'text', text: `[[cc:wake-callback]]Worker \`aaaa1111\` finished.\n[[cc:wake-body]]${S}` }] } };

async function fixture(extra = {}) {
  const s = makeStore({
    sessions: {
      cccc0000: { ...sess({ id: 'cccc0000', backing: 'cb-cond' }), title: 'Conductor' },
      aaaa1111: sess({ id: 'aaaa1111', parent: 'cccc0000', project: 'p', worktree: 'wt', conducted: true, at: iso(T0 + min(10)), backing: 'bk-w1' }),
      bbbb2222: sess({ id: 'bbbb2222', parent: 'cccc0000', project: 'q', conducted: true, at: iso(T0 + min(3000)) }),
    },
    events: [
      // a migrated-style call: no caller, so it neither draws a link nor sets the backfill cutoff
      evCall(T0 + min(10), { type: 'conductor' }, 'aaaa1111', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
      evSession(T0 + min(60), SYSTEM, 'aaaa1111', 'exit', { cause: 'exited' }),
      { v: 1, ts: iso(T0 + min(70)), kind: 'hologram', actor: SYSTEM, subject: 'aaaa1111' },
      evCall(T0 + min(80), 'cccc0000', 'aaaa1111', 'frobnicate'),
    ],
    costs: [
      { ts: T0 + min(30), duration_ms: min(10), sessionId: 'aaaa1111' },
      { ts: T0 + min(130), duration_ms: min(20), sessionId: 'bk-w1' },
      { ts: T0 + min(300), duration_ms: min(5), sessionId: 'aaaa1111' },
    ],
    transcripts: { 'cb-cond': [call('toolu_1', 'aaaa1111'), result('toolu_1'), wake] },
    ...extra,
  });
  const state = createState(s.config);
  await state.refreshStores();
  await state.runBackfill();
  return { s, state };
}
const win = { from: T0, to: T0 + min(120), now: T0 + min(5000) };

test('the window keeps overlapping sessions and clips turns and links to it', async () => {
  const { s, state } = await fixture();
  const p = buildPayload(state, win);
  assert.deepEqual(Object.keys(p.sessions).sort(), ['aaaa1111', 'cccc0000']);
  assert.deepEqual(p.sessions.aaaa1111.turns, [[T0 + min(20), T0 + min(30)], [T0 + min(110), T0 + min(120)]]);
  assert.ok(p.links.every((l) => l.ts >= win.from && l.ts <= win.to));
  assert.deepEqual(p.projects.map((g) => g.project), ['p']);
  assert.deepEqual(p.projects[0].trees[0].rows.map((r) => [r.id, r.context]), [['cccc0000', true], ['aaaa1111', false]]);
  s.cleanup();
});

test('linkTypes equals LINK_TYPES and the payload carries bars, links and diagnostics', async () => {
  const { s, state } = await fixture();
  const p = buildPayload(state, win);
  assert.deepEqual(p.linkTypes, LINK_TYPES);
  assert.equal(p.sessions.aaaa1111.endKind, 'exited');
  assert.equal(p.sessions.aaaa1111.playbook, 'classic');
  assert.equal(p.sessions.cccc0000.title, 'Conductor');
  const types = new Set(p.links.map((l) => l.type));
  assert.ok(types.has('spawn') && types.has('send_prompt') && types.has('wake') && types.has('other'));
  const d = p.diagnostics;
  assert.equal(d.liveness, 'unavailable');
  assert.equal(d.backfill.state, 'ready');
  assert.deepEqual(d.unknownKinds, { hologram: 1 });
  assert.equal(d.otherVersionRows, 0);
  assert.deepEqual(d.unknownTools, { frobnicate: 1 });
  assert.equal(d.cutoff, iso(T0 + min(80)));
  assert.equal(d.unresolved, 0);
  assert.deepEqual(d.missing, []);
  s.cleanup();
});

test('a live session is open-ended only when liveness is available', async () => {
  const { s, state } = await fixture({ events: [] });
  assert.equal(buildPayload(state, win).sessions.aaaa1111.endKind, 'approx');
  state.liveSet = new Set(['aaaa1111']);
  const p = buildPayload(state, win);
  assert.equal(p.sessions.aaaa1111.endKind, 'live');
  assert.equal(p.sessions.aaaa1111.end, null);
  assert.equal(p.diagnostics.liveness, 'ok');
  s.cleanup();
});

test('missing store files are reported in diagnostics.missing', async () => {
  const s = makeStore();
  const fs = await import('node:fs');
  fs.rmSync(s.files.events);
  fs.rmSync(s.files.costs);
  const state = createState(s.config);
  await state.refreshStores();
  const p = buildPayload(state, win);
  assert.deepEqual(p.diagnostics.missing.sort(), ['costs.jsonl', 'events.jsonl']);
  s.cleanup();
});

test('the serialised payload contains no prompt sentinel', async () => {
  const { s, state } = await fixture();
  const p = buildPayload(state, { from: T0 - min(10), to: T0 + min(6000), now: T0 + min(6000) });
  assert.ok(p.links.some((l) => l.source === 'backfill'));
  assert.equal(JSON.stringify(p).includes(S), false);
  s.cleanup();
});

test('C7: event-log rows and cost rows of sessions that are not in sessions.json are counted, not silently dropped', async () => {
  const { s, state } = await fixture({
    events: [
      evCall(T0 + min(10), 'cccc0000', 'aaaa1111', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
      evCall(T0 + min(11), 'cccc0000', 'deadbeef', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
      evSession(T0 + min(12), SYSTEM, 'deadbeef', 'exit'),
      evCall(T0 + min(13), 'cccc0000', undefined, 'spawn_instance', { outcome: 'refused' }),
    ],
    costs: [
      { ts: T0 + min(30), duration_ms: 1000, sessionId: 'aaaa1111' },
      { ts: T0 + min(31), duration_ms: 1000, sessionId: 'deadbeef' },
      { ts: T0 + min(32), duration_ms: 1000, sessionId: 'deadbeef' },
    ],
  });
  const d = buildPayload(state, win).diagnostics;
  assert.deepEqual(d.unmatchedStoreRows, { events: 2, costs: 2 });
  s.cleanup();
});

test('R5: sessions whose ids are named like Object.prototype members still appear in the payload', async () => {
  const { s, state } = await fixture({
    sessions: {
      cccc0000: sess({ id: 'cccc0000', backing: 'cb-cond' }),
      constructor: sess({ id: 'constructor', parent: 'cccc0000', project: 'p', conducted: true, at: iso(T0 + min(10)) }),
      toString: sess({ id: 'toString', parent: 'cccc0000', project: 'p', conducted: true, at: iso(T0 + min(11)) }),
    },
    events: [], costs: [], transcripts: {},
  });
  const p = buildPayload(state, win);
  assert.deepEqual(Object.keys(p.sessions).sort(), ['cccc0000', 'constructor', 'toString']);
  assert.ok(p.links.some((l) => l.type === 'spawn' && l.to === 'constructor'));
  s.cleanup();
});

test('turns: a costs turn before the first turn row is drawn, one after it is not; a turn-row turn is drawn', async () => {
  const { s, state } = await fixture({
    events: [
      evSession(T0 + min(10), SYSTEM, 'aaaa1111', 'start'),
      evTurn(T0 + min(100), 'cccc0000', 'aaaa1111', 'start'),
      evTurn(T0 + min(110), SYSTEM, 'aaaa1111', 'end'),
    ],
    costs: [
      { ts: T0 + min(30), duration_ms: min(10), sessionId: 'aaaa1111' }, // before the first turn row: kept
      { ts: T0 + min(105), duration_ms: min(5), sessionId: 'aaaa1111' }, // after it: the turn rows own this period
    ],
  });
  const p = buildPayload(state, { from: T0, to: T0 + min(300), now: T0 + min(5000) });
  assert.deepEqual(p.sessions.aaaa1111.turns, [[T0 + min(20), T0 + min(30)], [T0 + min(100), T0 + min(110)]]);
  assert.equal(p.sessions.aaaa1111.turnCount, 2);
  s.cleanup();
});

test('turns: with no turn row at all every costs turn is used', async () => {
  const { s, state } = await fixture();
  const p = buildPayload(state, { from: T0, to: T0 + min(400), now: T0 + min(5000) });
  assert.equal(p.sessions.aaaa1111.turns.length, 3);
  s.cleanup();
});

test('turns: an open turn runs to now on a live bar and to the bar end on an approx bar', async () => {
  const events = [evSession(T0 + min(10), SYSTEM, 'aaaa1111', 'start'), evTurn(T0 + min(100), 'cccc0000', 'aaaa1111', 'start')];
  const { s, state } = await fixture({ events, costs: [] });
  const w = { from: T0, to: T0 + min(5000), now: T0 + min(500) };
  const approx = buildPayload(state, w).sessions.aaaa1111;
  assert.equal(approx.endKind, 'approx');
  assert.deepEqual(approx.turns.at(-1), [T0 + min(100), approx.end]);
  state.liveSet = new Set(['aaaa1111']);
  const live = buildPayload(state, w).sessions.aaaa1111;
  assert.deepEqual([live.endKind, live.turns.at(-1)], ['live', [T0 + min(100), T0 + min(500)]]);
  s.cleanup();
});

test('the payload reports other-version rows and the first attributed call as the backfill cutoff', async () => {
  const { s, state } = await fixture({
    events: [
      { ...evSession(T0 + min(5), SYSTEM, 'aaaa1111', 'start'), v: 2 },
      evCall(T0 + min(20), { type: 'conductor' }, 'aaaa1111', 'send_prompt'),
      evCall(T0 + min(40), 'cccc0000', 'aaaa1111', 'send_prompt'),
    ],
  });
  const d = buildPayload(state, win).diagnostics;
  assert.equal(d.otherVersionRows, 1);
  assert.equal(d.cutoff, iso(T0 + min(40)));
  s.cleanup();
});

const W = { from: T0, to: T0 + min(400), now: T0 + min(5000) };

test('stages and playbook come from reader-produced bind and move rows', async () => {
  const { s, state } = await fixture({
    events: [
      evCall(T0 + min(10), 'cccc0000', 'aaaa1111', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
      evCall(T0 + min(20), 'cccc0000', 'aaaa1111', 'approve_plan', { move: { from: 'plan', to: 'implement' } }),
      evSession(T0 + min(60), SYSTEM, 'aaaa1111', 'exit', { cause: 'exited' }),
    ],
    costs: [], transcripts: {},
  });
  const a = buildPayload(state, W).sessions.aaaa1111;
  assert.equal(a.playbook, 'classic');
  assert.deepEqual(a.stages, [
    { stage: 'plan', from: T0 + min(10), to: T0 + min(20) },
    { stage: 'implement', from: T0 + min(20), to: T0 + min(60), via: 'approve_plan' },
  ]);
  s.cleanup();
});

test('a refused call row carrying bind or move is admitted to the bar at any outcome', async () => {
  const { s, state } = await fixture({
    events: [
      evCall(T0 + min(10), 'cccc0000', 'aaaa1111', 'spawn_instance', { outcome: 'refused', bind: { playbook: 'warned', stage: 'plan' } }),
      evCall(T0 + min(20), 'cccc0000', 'aaaa1111', 'send_prompt', { outcome: 'refused', move: { from: 'plan', to: 'review' } }),
    ],
    costs: [], transcripts: {},
  });
  const a = buildPayload(state, W).sessions.aaaa1111;
  assert.equal(a.playbook, 'warned');
  assert.deepEqual(a.stages.map((x) => [x.stage, x.via]), [['plan', undefined], ['review', 'send_prompt']]);
  s.cleanup();
});

test('an approx bar extends to its latest mention as a caller, as a forward source, or as a wake recipient (rows that draw no link)', async () => {
  const at = T0 + min(200);
  const cases = {
    caller: [evCall(at, 'aaaa1111', undefined, 'spawn_instance', { outcome: 'refused' })],
    forward: [evCall(at, 'cccc0000', 'ghost0000', 'send_prompt', { outcome: 'refused', forward: 'aaaa1111' })],
    recipient: [evWake(at, 'ghost0000', 'aaaa1111')],
  };
  for (const [name, events] of Object.entries(cases)) {
    const { s, state } = await fixture({ events, costs: [], transcripts: {} });
    const p = buildPayload(state, { from: T0, to: T0 + min(300), now: T0 + min(5000) });
    assert.equal(p.links.filter((l) => l.type !== 'spawn').length, 0, name);
    assert.deepEqual([p.sessions.aaaa1111.endKind, p.sessions.aaaa1111.end], ['approx', at], name);
    s.cleanup();
  }
});
