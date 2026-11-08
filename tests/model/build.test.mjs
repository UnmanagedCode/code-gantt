import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, sess, iso, T0, min, evCall, evSession, evTurn, evWake, horizonRows, SYSTEM } from '../helpers/store.mjs';
import { PROMPT_SENTINEL as S } from '../helpers/sentinel.mjs';
import { createState } from '../../src/state.js';
import { buildPayload } from '../../src/model/build.js';
import { LINK_TYPES } from '../../src/model/linkTypes.js';

const HZ = horizonRows(T0, 'bbbb2222', 'cccc0000'); // opens the horizon at T0 without touching aaaa1111

async function fixture(extra = {}) {
  const s = makeStore({
    sessions: {
      cccc0000: { ...sess({ id: 'cccc0000', backing: 'cb-cond' }), title: 'Conductor' },
      aaaa1111: sess({ id: 'aaaa1111', parent: 'cccc0000', project: 'p', worktree: 'wt', conducted: true, at: iso(T0 + min(10)), backing: 'bk-w1' }),
      bbbb2222: sess({ id: 'bbbb2222', parent: 'cccc0000', project: 'q', conducted: true, at: iso(T0 + min(3000)) }),
    },
    events: [
      ...horizonRows(T0, 'aaaa1111', 'cccc0000'),
      // a migrated-style call: no caller, so it draws no link
      evCall(T0 + min(10), { type: 'conductor' }, 'aaaa1111', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
      evCall(T0 + min(15), 'cccc0000', 'aaaa1111', 'send_prompt'),
      evTurn(T0 + min(20), 'cccc0000', 'aaaa1111', 'start'), evTurn(T0 + min(30), SYSTEM, 'aaaa1111', 'end'),
      evSession(T0 + min(60), SYSTEM, 'aaaa1111', 'exit', { cause: 'exited' }),
      { v: 1, ts: iso(T0 + min(70)), kind: 'hologram', actor: SYSTEM, subject: 'aaaa1111' },
      evCall(T0 + min(80), 'cccc0000', 'aaaa1111', 'frobnicate'),
      evTurn(T0 + min(110), 'cccc0000', 'aaaa1111', 'start'), evTurn(T0 + min(130), SYSTEM, 'aaaa1111', 'end'),
    ],
    ...extra,
  });
  const state = createState(s.config);
  await state.refreshStores();
  return { s, state };
}
const win = { from: T0, to: T0 + min(120), now: T0 + min(5000) };

test('the window keeps overlapping sessions and clips turns and links to it', async () => {
  const { s, state } = await fixture();
  const p = buildPayload(state, win);
  assert.deepEqual(Object.keys(p.sessions).sort(), ['aaaa1111', 'cccc0000']);
  assert.deepEqual(p.sessions.aaaa1111.turns, [[T0 + min(20), T0 + min(30)], [T0 + min(110), T0 + min(120)]]);
  assert.ok(p.links.every((l) => l.ts >= win.from && l.ts <= win.to));
  assert.equal('projects' in p, false);
  assert.equal(p.conductorProject, '.conduct');
  assert.deepEqual(p.trees.map((t) => t.rootId), ['cccc0000']);
  assert.deepEqual(p.trees[0].rows.map((r) => [r.id, r.depth, r.role]), [['cccc0000', 0, 'conductor'], ['aaaa1111', 1, 'worker']]);
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
  assert.deepEqual(d.unknownKinds, { hologram: 1 });
  assert.equal(d.otherVersionRows, 0);
  assert.deepEqual(d.unknownTools, { frobnicate: 1 });
  assert.equal(d.horizon, iso(T0));
  assert.equal(d.unresolved, 0);
  assert.deepEqual(d.missing, []);
  s.cleanup();
});

test('a live session is open-ended only when liveness is available', async () => {
  const { s, state } = await fixture({ events: [...horizonRows(T0, 'aaaa1111', 'cccc0000')] });
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
  const state = createState(s.config);
  await state.refreshStores();
  const p = buildPayload(state, win);
  assert.deepEqual(p.diagnostics.missing, ['events.jsonl']);
  s.cleanup();
});

test('the serialised payload carries no unknown row field (no prompt text)', async () => {
  const { s, state } = await fixture({
    events: [...horizonRows(T0, 'aaaa1111', 'cccc0000'), { ...evCall(T0 + min(15), 'cccc0000', 'aaaa1111', 'send_prompt'), text: S, input: { text: S } }],
  });
  const p = buildPayload(state, { from: T0 - min(10), to: T0 + min(6000), now: T0 + min(6000) });
  assert.ok(p.links.some((l) => l.type === 'send_prompt'));
  assert.equal(JSON.stringify(p).includes(S), false);
  s.cleanup();
});

test('C7: event-log rows of sessions that are not in sessions.json are counted, not silently dropped', async () => {
  const { s, state } = await fixture({
    events: [
      ...HZ,
      evCall(T0 + min(10), 'cccc0000', 'aaaa1111', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
      evCall(T0 + min(11), 'cccc0000', 'deadbeef', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
      evSession(T0 + min(12), SYSTEM, 'deadbeef', 'exit'),
      evCall(T0 + min(13), 'cccc0000', undefined, 'spawn_instance', { outcome: 'refused' }),
    ],
  });
  const d = buildPayload(state, win).diagnostics;
  assert.deepEqual(d.unmatchedStoreRows, { events: 2 });
  s.cleanup();
});

test('R5: sessions whose ids are named like Object.prototype members still appear in the payload', async () => {
  const { s, state } = await fixture({
    sessions: {
      cccc0000: sess({ id: 'cccc0000', backing: 'cb-cond' }),
      constructor: sess({ id: 'constructor', parent: 'cccc0000', project: 'p', conducted: true, at: iso(T0 + min(10)) }),
      toString: sess({ id: 'toString', parent: 'cccc0000', project: 'p', conducted: true, at: iso(T0 + min(11)) }),
    },
    events: [...horizonRows(T0, 'constructor', 'cccc0000')],
  });
  const p = buildPayload(state, win);
  assert.deepEqual(Object.keys(p.sessions).sort(), ['cccc0000', 'constructor', 'toString']);
  assert.ok(p.links.some((l) => l.type === 'spawn' && l.to === 'constructor'));
  s.cleanup();
});

test('turns: an open turn runs to now on a live bar and to the bar end on an approx bar', async () => {
  const events = [...HZ, evSession(T0 + min(10), SYSTEM, 'aaaa1111', 'start'), evTurn(T0 + min(100), 'cccc0000', 'aaaa1111', 'start')];
  const { s, state } = await fixture({ events });
  const w = { from: T0, to: T0 + min(5000), now: T0 + min(500) };
  const approx = buildPayload(state, w).sessions.aaaa1111;
  assert.equal(approx.endKind, 'approx');
  assert.deepEqual(approx.turns.at(-1), [T0 + min(100), approx.end]);
  state.liveSet = new Set(['aaaa1111']);
  const live = buildPayload(state, w).sessions.aaaa1111;
  assert.deepEqual([live.endKind, live.turns.at(-1)], ['live', [T0 + min(100), T0 + min(500)]]);
  s.cleanup();
});

test('the payload counts other-version rows', async () => {
  const { s, state } = await fixture({ events: [...HZ, { ...evSession(T0 + min(5), SYSTEM, 'aaaa1111', 'start'), v: 2 }] });
  assert.equal(buildPayload(state, win).diagnostics.otherVersionRows, 1);
  s.cleanup();
});

const W = { from: T0, to: T0 + min(400), now: T0 + min(5000) };

test('stages and playbook come from reader-produced bind and move rows', async () => {
  const { s, state } = await fixture({
    events: [
      ...HZ,
      evCall(T0 + min(10), 'cccc0000', 'aaaa1111', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
      evCall(T0 + min(20), 'cccc0000', 'aaaa1111', 'approve_plan', { move: { from: 'plan', to: 'implement' } }),
      evSession(T0 + min(60), SYSTEM, 'aaaa1111', 'exit', { cause: 'exited' }),
    ],
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
      ...HZ,
      evCall(T0 + min(10), 'cccc0000', 'aaaa1111', 'spawn_instance', { outcome: 'refused', bind: { playbook: 'warned', stage: 'plan' } }),
      evCall(T0 + min(20), 'cccc0000', 'aaaa1111', 'send_prompt', { outcome: 'refused', move: { from: 'plan', to: 'review' } }),
    ],
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
    const { s, state } = await fixture({ events: [...HZ, ...events] });
    const p = buildPayload(state, { from: T0, to: T0 + min(300), now: T0 + min(5000) });
    assert.equal(p.links.filter((l) => l.type !== 'spawn').length, 0, name);
    assert.deepEqual([p.sessions.aaaa1111.endKind, p.sessions.aaaa1111.end], ['approx', at], name);
    s.cleanup();
  }
});

// ---- the horizon ----
// One store, horizon H = T0+100min (the first turn row; the first attributed call at T0+45 is earlier).
const H = T0 + min(100);
const HW = { from: T0, to: T0 + min(400), now: T0 + min(1000) };
const mig = { type: 'conductor' }; // migrated rows carry no caller
const later = (id, over = {}) => sess({ id, parent: 'cccc0000', project: 'p', conducted: true, ...over });

async function horizonStore(extraSessions = {}, extraEvents = [], lateEvents = []) {
  const s = makeStore({
    sessions: {
      cccc0000: sess({ id: 'cccc0000' }),
      eeee0001: later('eeee0001', { at: iso(T0 + min(10)) }), // exits before H
      ssss0001: { ...later('ssss0001', { at: iso(T0 + min(20)), segments: [
        { id: 's-0', reason: 'initial', at: iso(T0 + min(20)) },
        { id: 's-1', reason: 'renew', at: iso(T0 + min(35)) },
        { id: 's-2', reason: 'renew', at: iso(T0 + min(128)) },
      ] }) }, // spans H
      llll0001: later('llll0001', { at: iso(T0 + min(150)) }), // wholly after H
      oooo0000: sess({ id: 'oooo0000', at: iso(T0 + min(5)) }), // a tree wholly before H, in another project
      oooo0001: sess({ id: 'oooo0001', parent: 'oooo0000', project: 'q', conducted: true, at: iso(T0 + min(6)) }),
      kkkk0001: later('kkkk0001', { at: iso(T0 + min(12)) }), // killed before H by a call, no exit row
      mmmm0001: later('mmmm0001', { at: iso(T0 + min(13)) }), // last mention before H
      nnnn0001: later('nnnn0001', { at: iso(T0 + min(14)) }), // last mention after H
      ...extraSessions,
    },
    events: [
      evCall(T0 + min(25), mig, 'ssss0001', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
      evSession(T0 + min(30), SYSTEM, 'ssss0001', 'exit', { cause: 'exited' }),
      evSession(T0 + min(31), SYSTEM, 'ssss0001', 'resume', { cause: 'restore' }),
      evCall(T0 + min(40), mig, 'ssss0001', 'approve_plan', { move: { from: 'plan', to: 'implement' } }),
      evCall(T0 + min(45), 'cccc0000', 'ssss0001', 'send_prompt'), // first attributed call, before H: its link is dropped
      evSession(T0 + min(50), SYSTEM, 'oooo0001', 'exit', { cause: 'exited' }),
      evSession(T0 + min(55), SYSTEM, 'oooo0000', 'exit', { cause: 'exited' }),
      evSession(T0 + min(60), SYSTEM, 'eeee0001', 'exit', { cause: 'exited' }),
      evCall(T0 + min(62), 'cccc0000', 'kkkk0001', 'kill_instance'),
      evCall(T0 + min(70), mig, 'mmmm0001', 'send_prompt'),
      ...extraEvents,
      evWake(T0 + min(95), 'ssss0001', 'cccc0000'),
      evTurn(H, 'cccc0000', 'ssss0001', 'start'), // the first turn row: H
      evCall(T0 + min(105), 'cccc0000', 'ssss0001', 'approve_plan', { move: { from: 'implement', to: 'review' } }),
      evCall(T0 + min(106), 'cccc0000', 'ssss0001', 'send_prompt'),
      evWake(T0 + min(108), 'ssss0001', 'cccc0000', { heartbeat: true }),
      evTurn(T0 + min(110), SYSTEM, 'ssss0001', 'end'),
      evTurn(T0 + min(120), 'cccc0000', 'ssss0001', 'start'), evTurn(T0 + min(125), SYSTEM, 'ssss0001', 'end'),
      evSession(T0 + min(130), SYSTEM, 'ssss0001', 'resume', { cause: 'restore' }),
      evWake(T0 + min(150), 'nnnn0001', 'cccc0000'),
      evCall(T0 + min(160), 'cccc0000', 'llll0001', 'send_prompt'),
      // post-horizon evidence: were the exit or the kill ignored, these two would be approx bars crossing the horizon
      evTurn(T0 + min(170), 'cccc0000', 'eeee0001', 'start'), evTurn(T0 + min(171), SYSTEM, 'eeee0001', 'end'),
      evTurn(T0 + min(172), 'cccc0000', 'kkkk0001', 'start'), evTurn(T0 + min(173), SYSTEM, 'kkkk0001', 'end'),
      ...lateEvents,
    ],
  });
  const state = createState(s.config);
  await state.refreshStores();
  return { s, state, p: buildPayload(state, HW) };
}
// a row that overlaps the horizon draws; one that ended earlier is a label-only ancestor
const drawsFrom = (id, p) => p.sessions[id].end == null || p.sessions[id].end >= Date.parse(p.diagnostics.horizon);
const treeRows = (p, rootId) => p.trees.find((t) => t.rootId === rootId)?.rows;

// P1: a session whose bar ended before H is hidden with its links; a tree of only such sessions is absent.
test('a session whose bar ends before the horizon is not shown, nor are its links; a tree with only such sessions is absent', async () => {
  const { s, p } = await horizonStore();
  for (const id of ['eeee0001', 'oooo0000', 'oooo0001']) assert.equal(id in p.sessions, false, id);
  assert.equal(p.trees.some((t) => t.rootId === 'oooo0000'), false);
  assert.ok(p.links.every((l) => l.from in p.sessions && l.to in p.sessions));
  assert.deepEqual(treeRows(p, 'cccc0000').filter((r) => r.depth > 0 && drawsFrom(r.id, p)).map((r) => r.id).sort(), ['llll0001', 'nnnn0001', 'ssss0001']);
  s.cleanup();
});

// P2: clipping end to end through buildPayload.
test('a bar spanning the horizon is clipped: start = horizon, the stage held is carried in, and turns, links, marks and rotations come from the horizon on', async () => {
  const { s, p } = await horizonStore();
  const b = p.sessions.ssss0001;
  assert.equal(b.start, H);
  assert.equal(b.playbook, 'classic');
  assert.deepEqual(b.stages, [
    { stage: 'implement', from: H, to: T0 + min(105), via: 'approve_plan' },
    { stage: 'review', from: T0 + min(105), to: b.end, via: 'approve_plan' },
  ]);
  assert.deepEqual(b.turns, [[H, T0 + min(110)], [T0 + min(120), T0 + min(125)]]);
  assert.deepEqual(b.marks, [{ at: T0 + min(130), kind: 'resume' }]);
  assert.deepEqual(b.rotations, [{ at: T0 + min(128), reason: 'renew' }]);
  assert.deepEqual(p.links.filter((l) => l.to === 'ssss0001' || l.from === 'ssss0001').map((l) => [l.type, l.ts]), [
    ['approve_plan', T0 + min(105)], ['send_prompt', T0 + min(106)], ['wake', T0 + min(108)],
  ]);
  s.cleanup();
});

// P3: the sweep. Nothing before H is drawn for a row that overlaps H (a label-only ancestor draws nothing), whatever window is asked for.
test('nothing before the horizon is drawn: for every row that draws from the horizon the start, marks, rotations, stage froms and turn starts, and every link ts, are >= horizon; window.from is clamped to it', async () => {
  const { s, state, p } = await horizonStore();
  assert.equal(p.window.from, H);
  const drawn = new Set(p.trees.flatMap((t) => t.rows.filter((r) => r.depth > 0 && drawsFrom(r.id, p)).map((r) => r.id)));
  assert.ok(drawn.size >= 3);
  for (const id of drawn) {
    const b = p.sessions[id];
    const times = [b.start, ...b.marks.map((m) => m.at), ...b.rotations.map((r) => r.at), ...b.stages.map((x) => x.from), ...b.turns.map(([a]) => a)];
    assert.ok(times.every((t) => t >= H), id);
  }
  assert.ok(p.links.length > 0 && p.links.every((l) => l.ts >= H));
  // a window that starts after H is honoured
  assert.equal(buildPayload(state, { from: H + min(10), to: H + min(300), now: HW.now }).window.from, H + min(10));
  s.cleanup();
});

// P4: no horizon, no drawing.
test('with no horizon the payload has no trees, sessions or links and reports horizon null', async () => {
  const unattributed = [evCall(T0, mig, 'aaaa1111', 'send_prompt'), evSession(T0 + min(60), SYSTEM, 'aaaa1111', 'exit')];
  const cases = {
    'no event rows': [],
    'unattributed calls only': unattributed,
    'turn rows only': [evTurn(T0, 'cccc0000', 'aaaa1111', 'start'), evTurn(T0 + min(5), SYSTEM, 'aaaa1111', 'end')],
    'wake only': [evWake(T0, 'aaaa1111', 'cccc0000')],
  };
  for (const [name, events] of Object.entries(cases)) {
    const { s, state } = await fixture({ events });
    const p = buildPayload(state, win);
    assert.deepEqual([p.trees, p.sessions, p.links, p.diagnostics.horizon, p.window], [[], {}, [], null, { from: win.from, to: win.to }], name);
    s.cleanup();
  }
});

// C1: a window that ends before the horizon is never inverted and draws nothing.
test('a window wholly before the horizon emits nothing drawable, keeps the requested window and still reports the horizon; no window or turn is ever inverted', async () => {
  const { s, state } = await horizonStore();
  const before = buildPayload(state, { from: T0, to: H - min(10), now: HW.now });
  assert.deepEqual([before.trees, before.sessions, before.links], [[], {}, []]);
  assert.deepEqual(before.window, { from: T0, to: H - min(10) });
  assert.equal(before.diagnostics.horizon, iso(H));
  for (const to of [T0 + min(1), H - 1, H, H + 1, H + min(15), H + min(400)]) {
    const p = buildPayload(state, { from: T0, to, now: HW.now });
    assert.ok(p.window.from <= p.window.to, `window at to=${to - H}`);
    for (const b of Object.values(p.sessions)) assert.ok(b.turns.every(([a, e]) => a <= e), `turns at to=${to - H}`);
  }
  s.cleanup();
});

// T3: a turn that starts before the horizon (the first turn row predates the first wake or attributed call).
test('a turn segment that starts before the horizon on a bar reaching past it is emitted starting at the horizon; a turn wholly before it is not emitted', async () => {
  const { s, state } = await fixture({
    events: [
      evTurn(T0 + min(2), 'cccc0000', 'aaaa1111', 'start'), evTurn(T0 + min(5), SYSTEM, 'aaaa1111', 'end'), // the first turn row
      evTurn(T0 + min(10), 'cccc0000', 'aaaa1111', 'start'),
      evCall(T0 + min(20), 'cccc0000', 'aaaa1111', 'send_prompt'), // the first attributed call: the horizon
      evTurn(T0 + min(30), SYSTEM, 'aaaa1111', 'end'),
    ],
  });
  const p = buildPayload(state, { from: T0, to: T0 + min(100), now: T0 + min(5000) });
  assert.equal(p.diagnostics.horizon, iso(T0 + min(20)));
  assert.deepEqual(p.sessions.aaaa1111.turns, [[T0 + min(20), T0 + min(30)]]);
  s.cleanup();
});

// P5: hidden ancestors.
test('a hidden ancestor of a visible row is kept as a label-only row, whatever its project', async () => {
  const ended = (id) => evSession(T0 + min(65), SYSTEM, id, 'exit', { cause: 'exited' });
  const alive = (id) => evTurn(T0 + min(140), 'cccc0000', id, 'start');
  const { s, p } = await horizonStore({
    rooo0001: sess({ id: 'rooo0001', at: iso(T0 + min(8)) }), // hidden root, hidden other-project mid
    midd0001: sess({ id: 'midd0001', parent: 'rooo0001', project: 'm', conducted: true, at: iso(T0 + min(9)) }),
    chld0001: sess({ id: 'chld0001', parent: 'midd0001', project: 'p', conducted: true, at: iso(T0 + min(60)) }),
    rtb00001: sess({ id: 'rtb00001', at: iso(T0 + min(7)) }), // hidden root, hidden same-project parent
    par00001: sess({ id: 'par00001', parent: 'rtb00001', project: 'p', conducted: true, at: iso(T0 + min(11)) }),
    kid00001: sess({ id: 'kid00001', parent: 'par00001', project: 'p', conducted: true, at: iso(T0 + min(62)) }),
  }, [ended('rooo0001'), ended('midd0001'), ended('rtb00001'), ended('par00001')], [alive('chld0001'), alive('kid00001')]);
  // hidden ancestors: kept, drawn as labels only, still resolvable in sessions
  assert.deepEqual(treeRows(p, 'rooo0001').map((r) => [r.id, r.depth]), [['rooo0001', 0], ['midd0001', 1], ['chld0001', 2]]);
  for (const id of ['rooo0001', 'midd0001']) {
    const b = p.sessions[id];
    assert.ok(b.end < H, id);
    assert.deepEqual([b.marks, b.rotations, b.stages, b.turns], [[], [], [], []], id);
  }
  assert.deepEqual(treeRows(p, 'rtb00001').map((r) => [r.id, r.depth]), [['rtb00001', 0], ['par00001', 1], ['kid00001', 2]]);
  assert.ok('par00001' in p.sessions);
  s.cleanup();
});

// P6: the horizon clips the output, never the inputs that decide how a bar ends.
test('a pre-horizon exit, kill or last mention still ends the bar and hides it; a post-horizon mention keeps an approx bar visible', async () => {
  const { s, p } = await horizonStore();
  // eeee0001 (exit) and kkkk0001 (kill link) have post-horizon turn rows: only their terminator keeps them hidden
  for (const id of ['eeee0001', 'kkkk0001', 'mmmm0001']) assert.equal(id in p.sessions, false, `${id} hidden`);
  const n = p.sessions.nnnn0001;
  assert.deepEqual([n.endKind, n.end, n.start], ['approx', T0 + min(150), H]);
  s.cleanup();
});

// P6b: hidden sessions are not observable, so the same wiring is pinned on context ancestors, whose bars
// are emitted (label-only) with their real end.
test('a hidden context ancestor keeps the end that its pre-horizon exit, kill link or last mention gave it', async () => {
  const kid = (id, parent) => sess({ id, parent, project: 'p', conducted: true, at: iso(T0 + min(60)) });
  const { s, p } = await horizonStore({
    rxa00001: sess({ id: 'rxa00001', at: iso(T0 + min(8)) }), // system exit before H, post-horizon turn row
    rxb00001: sess({ id: 'rxb00001', at: iso(T0 + min(8)) }), // kill_instance link before H, no exit, post-horizon turn row
    rxc00001: sess({ id: 'rxc00001', at: iso(T0 + min(8)) }), // last mention before H, nothing after
    cha00001: kid('cha00001', 'rxa00001'), chb00001: kid('chb00001', 'rxb00001'), chc00001: kid('chc00001', 'rxc00001'),
  }, [
    evSession(T0 + min(30), SYSTEM, 'rxa00001', 'exit', { cause: 'exited' }),
    evCall(T0 + min(63), 'cccc0000', 'rxb00001', 'kill_instance'),
    evCall(T0 + min(70), mig, 'rxc00001', 'send_prompt'),
  ], ['rxa00001', 'rxb00001', 'cha00001', 'chb00001', 'chc00001'].map((id) => evTurn(T0 + min(140), 'cccc0000', id, 'start')));
  const at = (id) => [p.sessions[id].endKind, p.sessions[id].end];
  assert.deepEqual(at('rxa00001'), ['exited', T0 + min(30)]);
  assert.deepEqual(at('rxb00001'), ['killed', T0 + min(63)]);
  assert.deepEqual(at('rxc00001'), ['approx', T0 + min(70)]);
  for (const id of ['rxa00001', 'rxb00001', 'rxc00001']) assert.deepEqual([p.sessions[id].turns, p.sessions[id].marks, p.sessions[id].stages], [[], [], []], id);
  s.cleanup();
});

// P7: protocol shape of diagnostics.
test('diagnostics carry horizon as ISO and no backfill or cutoff fields', async () => {
  const { s, p } = await horizonStore();
  const d = p.diagnostics;
  assert.equal(d.horizon, iso(H));
  assert.equal('backfill' in d || 'cutoff' in d, false);
  assert.deepEqual(Object.keys(d.unmatchedStoreRows), ['events']);
  s.cleanup();
});

test('a window that drops the forward source keeps the send_prompt with its pair intact and has no forward link', async () => {
  // bbbb2222 starts after the window, so it is absent from the payload
  const { s, state } = await fixture({
    events: [
      ...horizonRows(T0, 'aaaa1111', 'cccc0000'),
      evCall(T0 + min(15), 'cccc0000', 'aaaa1111', 'send_prompt', { forward: 'bbbb2222' }),
    ],
  });
  const p = buildPayload(state, win);
  assert.equal(p.sessions.bbbb2222, undefined);
  assert.deepEqual(p.links.filter((l) => ['send_prompt', 'forward'].includes(l.type)).map((l) => [l.type, l.from, l.to, l.pair]),
    [['send_prompt', 'cccc0000', 'aaaa1111', { sender: 'cccc0000', source: 'bbbb2222' }]]);
  s.cleanup();
});

test('section leads: a lead that overlaps alone keeps its tree; a tree where only the root overlaps is dropped; roles are carried per row', async () => {
  const s = makeStore({
    sessions: {
      cccc0000: sess({ id: 'cccc0000' }),
      lead0001: sess({ id: 'lead0001', parent: 'cccc0000', project: '.conduct', conducted: true, at: iso(T0 + min(10)) }),
      work0001: sess({ id: 'work0001', parent: 'lead0001', project: 'p', conducted: true, at: iso(T0 + min(3000)) }),
      rrrr0000: sess({ id: 'rrrr0000' }),
      wwww0001: sess({ id: 'wwww0001', parent: 'rrrr0000', project: 'p', conducted: true, at: iso(T0 + min(3000)) }),
    },
    events: horizonRows(T0, 'lead0001', 'cccc0000'),
  });
  const state = createState(s.config);
  await state.refreshStores();
  const p = buildPayload(state, win);
  assert.deepEqual(p.trees.map((t) => t.rootId), ['cccc0000']);
  assert.deepEqual(p.trees[0].rows.map((r) => [r.id, r.depth, r.role]), [['cccc0000', 0, 'conductor'], ['lead0001', 1, 'lead']]);
  assert.equal('work0001' in p.sessions, false);
  s.cleanup();
});

test('a label-only ancestor that ended before the horizon draws nothing', async () => {
  const ended = evSession(T0 + min(65), SYSTEM, 'par00001', 'exit', { cause: 'exited' });
  const { s, p } = await horizonStore({
    rtb00001: sess({ id: 'rtb00001', at: iso(T0 + min(7)) }),
    par00001: sess({ id: 'par00001', parent: 'rtb00001', project: 'p', conducted: true, at: iso(T0 + min(11)) }),
    kid00001: sess({ id: 'kid00001', parent: 'par00001', project: 'p', conducted: true, at: iso(T0 + min(62)) }),
  }, [ended], [evTurn(T0 + min(140), 'cccc0000', 'kid00001', 'start')]);
  const b = p.sessions.par00001;
  assert.ok(b.end < H);
  assert.deepEqual([b.marks, b.rotations, b.stages, b.turns], [[], [], [], []]);
  assert.ok(treeRows(p, 'rtb00001').some((r) => r.id === 'par00001'));
  s.cleanup();
});

test('trees are ordered by root start, whatever the order or ids in sessions.json', async () => {
  const s = makeStore({
    sessions: {
      aaaa0002: sess({ id: 'aaaa0002', at: iso(T0 + min(50)) }),
      aaaa0003: sess({ id: 'aaaa0003', parent: 'aaaa0002', project: 'p', conducted: true, at: iso(T0 + min(51)) }),
      zzzz0002: sess({ id: 'zzzz0002', at: iso(T0 + min(5)) }),
      zzzz0003: sess({ id: 'zzzz0003', parent: 'zzzz0002', project: 'p', conducted: true, at: iso(T0 + min(6)) }),
    },
    events: horizonRows(T0, 'zzzz0003', 'zzzz0002'),
  });
  const state = createState(s.config);
  await state.refreshStores();
  const p = buildPayload(state, win);
  assert.deepEqual(p.trees.map((t) => t.rootId), ['zzzz0002', 'aaaa0002']);
  s.cleanup();
});
