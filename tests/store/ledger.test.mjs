import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeStore } from '../helpers/store.mjs';
import { LedgerReader } from '../../src/store/ledger.js';

const ev = (o) => ({ ts: '2026-11-01T00:00:00.000Z', ...o });

test('events are ordered by line position, not seq (duplicate and regressing seq kept)', async () => {
  const s = makeStore({ ledger: [
    ev({ seq: 5, kind: 'spawn', sessionId: 'a', stage: 'plan', playbook: 'classic' }),
    ev({ seq: 5, kind: 'transition', sessionId: 'a', to: 'implement', via: 'approve_plan' }),
    ev({ seq: 2, kind: 'retire', sessionId: 'a', reason: 'x' }),
  ] });
  const r = new LedgerReader(s.files.ledger);
  await r.refresh();
  assert.deepEqual(r.events.map((e) => e.kind), ['spawn', 'transition', 'retire']);
  assert.deepEqual(r.events.map((e) => e.line), [0, 1, 2]);
  s.cleanup();
});

test('unknown kind is skipped and counted; unknown field ignored; refusal/enforcement ignored silently', async () => {
  const s = makeStore({ ledger: [
    ev({ kind: 'hologram', sessionId: 'a' }),
    ev({ kind: 'retire', sessionId: 'a', reason: 'r', brandNew: 1 }),
    ev({ kind: 'refusal', tool: 'spawn_instance' }),
    ev({ kind: 'enforcement', conductorSessionId: 'c' }),
  ] });
  const r = new LedgerReader(s.files.ledger);
  await r.refresh();
  assert.deepEqual(r.events.map((e) => e.kind), ['retire']);
  assert.equal('brandNew' in r.events[0], false);
  assert.deepEqual(r.unknownKinds, { hologram: 1 });
  s.cleanup();
});

test('interaction (with/without forward) and wake (heartbeat) shapes are parsed; mcp prefix stripped', async () => {
  const s = makeStore({ ledger: [
    ev({ kind: 'interaction', conductorSessionId: 'c', sessionId: 'w', tool: 'send_prompt' }),
    ev({ kind: 'interaction', conductorSessionId: 'c', sessionId: 'w', tool: 'mcp__code-conductor__send_prompt', forwardSessionId: 'f' }),
    ev({ kind: 'wake', conductorSessionId: 'c', sessionId: 'w', heartbeat: true }),
  ] });
  const r = new LedgerReader(s.files.ledger);
  await r.refresh();
  const [a, b, w] = r.events;
  assert.equal(a.tool, 'send_prompt');
  assert.equal(a.forwardSessionId, undefined);
  assert.equal(b.tool, 'send_prompt');
  assert.equal(b.forwardSessionId, 'f');
  assert.equal(w.heartbeat, true);
  assert.equal(w.conductorSessionId, 'c');
  s.cleanup();
});

test('cutoffTs is the first interaction|wake ts, null when none', async () => {
  const s = makeStore({ ledger: [
    ev({ kind: 'spawn', sessionId: 'a' }),
    { ts: '2026-11-02T00:00:00.000Z', kind: 'wake', conductorSessionId: 'c', sessionId: 'a' },
    { ts: '2026-11-03T00:00:00.000Z', kind: 'interaction', conductorSessionId: 'c', sessionId: 'a', tool: 'send_prompt' },
  ] });
  const r = new LedgerReader(s.files.ledger);
  await r.refresh();
  assert.equal(r.cutoffTs, Date.parse('2026-11-02T00:00:00.000Z'));
  const s2 = makeStore({ ledger: [ev({ kind: 'spawn', sessionId: 'a' })] });
  const r2 = new LedgerReader(s2.files.ledger);
  await r2.refresh();
  assert.equal(r2.cutoffTs, null);
  s.cleanup(); s2.cleanup();
});

test('torn tail tolerated; incremental append yields only new events', async () => {
  const s = makeStore({ ledger: [ev({ kind: 'spawn', sessionId: 'a' })] });
  const r = new LedgerReader(s.files.ledger);
  const first = await r.refresh();
  assert.equal(first.length, 1);
  s.appendTorn(s.files.ledger, '{"ts":"2026-11-01T00:00:00.000Z","kind":"retire","sess');
  assert.equal((await r.refresh()).length, 0);
  s.append(s.files.ledger, 'ionId":"a","reason":"z"}\n');
  const third = await r.refresh();
  assert.deepEqual(third.map((e) => e.kind), ['retire']);
  assert.equal(r.events.length, 2);
  s.cleanup();
});

test('missing file yields empty data plus missing; corrupt non-trailing line counted', async () => {
  const s = makeStore({ ledger: [ev({ kind: 'spawn', sessionId: 'a' })] });
  fs.appendFileSync(s.files.ledger, 'garbage\n');
  s.appendLedger(ev({ kind: 'retire', sessionId: 'a', reason: 'r' }));
  const r = new LedgerReader(s.files.ledger);
  await r.refresh();
  assert.equal(r.events.length, 2);
  assert.equal(r.corruptLines, 1);
  const m = new LedgerReader('/nonexistent-xyz/l.jsonl');
  await m.refresh();
  assert.equal(m.missing, true);
  assert.deepEqual(m.events, []);
  s.cleanup();
});
