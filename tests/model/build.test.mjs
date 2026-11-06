import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, sess, iso, T0, min } from '../helpers/store.mjs';
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
    ledger: [
      { ts: iso(T0 + min(10)), kind: 'spawn', sessionId: 'aaaa1111', playbook: 'classic', stage: 'plan', text: S },
      { ts: iso(T0 + min(60)), kind: 'retire', sessionId: 'aaaa1111', reason: 'subprocess exited' },
      { ts: iso(T0 + min(70)), kind: 'hologram', sessionId: 'aaaa1111' },
      { ts: iso(T0 + min(80)), kind: 'interaction', conductorSessionId: 'cccc0000', sessionId: 'aaaa1111', tool: 'frobnicate' },
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
  assert.equal(p.sessions.aaaa1111.endKind, 'retired');
  assert.equal(p.sessions.aaaa1111.playbook, 'classic');
  assert.equal(p.sessions.cccc0000.title, 'Conductor');
  const types = new Set(p.links.map((l) => l.type));
  assert.ok(types.has('spawn') && types.has('send_prompt') && types.has('wake') && types.has('other'));
  const d = p.diagnostics;
  assert.equal(d.liveness, 'unavailable');
  assert.equal(d.backfill.state, 'ready');
  assert.deepEqual(d.unknownKinds, { hologram: 1 });
  assert.deepEqual(d.unknownTools, { frobnicate: 1 });
  assert.equal(d.cutoff, iso(T0 + min(80)));
  assert.equal(d.unresolved, 0);
  assert.deepEqual(d.missing, []);
  s.cleanup();
});

test('a live session is open-ended only when liveness is available', async () => {
  const { s, state } = await fixture({ ledger: [] });
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
  fs.rmSync(s.files.ledger);
  fs.rmSync(s.files.costs);
  const state = createState(s.config);
  await state.refreshStores();
  const p = buildPayload(state, win);
  assert.deepEqual(p.diagnostics.missing.sort(), ['costs.jsonl', 'playbook-ledger.jsonl']);
  s.cleanup();
});

test('the serialised payload contains no prompt sentinel', async () => {
  const { s, state } = await fixture();
  const p = buildPayload(state, { from: T0 - min(10), to: T0 + min(6000), now: T0 + min(6000) });
  assert.ok(p.links.some((l) => l.source === 'backfill'));
  assert.equal(JSON.stringify(p).includes(S), false);
  s.cleanup();
});

test('C7: ledger events and cost rows of sessions that are not in sessions.json are counted, not silently dropped', async () => {
  const { s, state } = await fixture({
    ledger: [
      { ts: iso(T0 + min(10)), kind: 'spawn', sessionId: 'aaaa1111', playbook: 'classic', stage: 'plan' },
      { ts: iso(T0 + min(11)), kind: 'spawn', sessionId: 'deadbeef', stage: 'plan' },
      { ts: iso(T0 + min(12)), kind: 'retire', sessionId: 'deadbeef', reason: 'x' },
    ],
    costs: [
      { ts: T0 + min(30), duration_ms: 1000, sessionId: 'aaaa1111' },
      { ts: T0 + min(31), duration_ms: 1000, sessionId: 'deadbeef' },
      { ts: T0 + min(32), duration_ms: 1000, sessionId: 'deadbeef' },
    ],
  });
  const d = buildPayload(state, win).diagnostics;
  assert.deepEqual(d.unmatchedStoreRows, { ledger: 2, costs: 2 });
  s.cleanup();
});
