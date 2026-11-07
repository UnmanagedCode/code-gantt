// A rich synthetic cc store for the golden-path harness (times are relative to "now").
import { makeStore, sess, iso, evCall, evSession, evTurn, evWake, SYSTEM, HUMAN } from '../../tests/helpers/store.mjs';

const H = 3600_000;
const M = 60_000;

const toolUse = (id, ts, tool, input) => ({ type: 'assistant', timestamp: iso(ts), uuid: `a-${id}`, message: { content: [{ type: 'tool_use', id, name: `mcp__code-conductor__${tool}`, input }] } });
const toolResult = (id, ts, ok = true) => ({ type: 'user', timestamp: iso(ts), uuid: `r-${id}`, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify({ ok }) }] }] } });
const wake = (uuid, ts, worker, heartbeat = false) => ({ type: 'user', timestamp: iso(ts), uuid, message: { content: [{ type: 'text', text: `[[cc:wake-callback]]Worker \`${worker}\` ${heartbeat ? 'did NOT finish — timed out' : 'finished its turn.'}\n[[cc:wake-body]]body` }] } });

export function buildFixture(now = Date.now()) {
  const t = (hoursAgo) => now - hoursAgo * H;
  const seg = (id, reason, at) => ({ id, reason, at: iso(at) });
  const sessions = {
    c0000001: { ...sess({ id: 'c0000001', title: 'Conductor', backing: 'cb-1', segments: [seg('cb-1', 'initial', t(70)), seg('cb-2', 'renew', t(30))] }), current: 'cb-2' },
    '1ead0001': sess({ id: '1ead0001', title: 'Alpha lead', parent: 'c0000001', project: 'alpha', conducted: true, at: iso(t(66)), backing: 'bk-lead' }),
    a0000001: sess({ id: 'a0000001', title: 'Beta worker (under lead)', parent: '1ead0001', project: 'beta', worktree: 'feat-b', conducted: true, at: iso(t(60)), backing: 'bk-1' }),
    a0000002: { ...sess({ id: 'a0000002', title: 'Alpha implementer', parent: 'c0000001', project: 'alpha', worktree: 'feat-a', conducted: true, turnEndSeq: 14, backing: 'bk-2',
      segments: [seg('bk-2', 'initial', t(64)), seg('bk-2b', 'renew', t(44)), seg('bk-2c', 'prune', t(40))] }), backend: { backend: 'claude', model: 'claude-opus-5-5' } },
    a0000003: sess({ id: 'a0000003', title: 'Alpha killed worker', parent: 'c0000001', project: 'alpha', conducted: true, at: iso(t(50)), backing: 'bk-3' }),
    a0000004: sess({ id: 'a0000004', title: 'Beta approx-end worker', parent: 'c0000001', project: 'beta', conducted: true, at: iso(t(36)), backing: 'bk-4' }),
    a0000005: sess({ id: 'a0000005', title: 'Beta recent worker', parent: 'c0000001', project: 'beta', conducted: true, at: iso(t(12)), backing: 'bk-5' }),
  };
  // Shaped like cc's events.jsonl (docs/event-log.md). Rows before the first attributed call (t(19)) have
  // the migrated shape: no caller on calls, system actors, no turn rows.
  const migrated = { type: 'conductor' };
  const C = 'c0000001';
  const events = [
    evCall(t(66), migrated, '1ead0001', 'spawn_instance', { bind: { playbook: 'split', stage: 'plan' } }),
    evCall(t(64), migrated, 'a0000002', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
    evCall(t(60), migrated, 'a0000001', 'spawn_instance', { bind: { playbook: 'classic', stage: 'implement' } }),
    evCall(t(58), migrated, 'a0000002', 'approve_plan', { move: { from: 'plan', to: 'implement' } }),
    evCall(t(50), migrated, 'a0000003', 'spawn_instance', { bind: { playbook: 'classic', stage: 'implement' } }),
    evCall(t(46), migrated, 'a0000002', 'send_prompt', { forward: 'a0000001', move: { from: 'implement', to: 'review' } }),
    evCall(t(36), migrated, 'a0000004', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
    evCall(t(27), migrated, 'a0000004', 'send_prompt'), // migrated, no caller: draws nothing
    evSession(t(40.1), SYSTEM, 'a0000002', 'exit', { cause: 'exited' }),
    evSession(t(40), SYSTEM, 'a0000002', 'resume', { cause: 'prune' }),
    evSession(t(34), SYSTEM, 'a0000002', 'exit', { cause: 'exited' }),
    // a conductor-initiated exit: killed with no kill call row needed
    evSession(t(30), { type: 'conductor', sessionId: C }, 'a0000001', 'exit', { cause: 'exited' }),
    // a migrated-style system exit followed by the kill_instance call (the first attributed call: the backfill cutoff)
    evSession(t(19), SYSTEM, 'a0000003', 'exit', { cause: 'exited' }),
    evCall(t(19) + 8, C, 'a0000003', 'kill_instance'),
    evWake(t(15), 'a0000005', C),
    evWake(t(14), 'a0000005', C, { heartbeat: true }),
    evCall(t(13), C, 'a0000005', 'set_mode'),
    evCall(t(12), C, 'a0000005', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
    evCall(t(11), C, 'a0000005', 'frobnicate'),
    evCall(t(10.5), C, 'a0000005', 'send_prompt', { move: { from: 'plan', to: 'implement' } }),
    evCall(t(9), C, 'a0000005', 'approve_plan', { move: { from: 'implement', to: 'review' } }),
    evCall(t(9.5), C, undefined, 'spawn_instance', { outcome: 'refused' }),
    // turn rows begin at t(18): older bars show costs.jsonl turns, newer ones turn-row turns
    evTurn(t(18), HUMAN, C, 'start'), evTurn(t(17.6), SYSTEM, C, 'end'),
    evTurn(t(14), HUMAN, C, 'start'), evTurn(t(13.7), SYSTEM, C, 'end'),
    evTurn(t(11.5), C, 'a0000005', 'start'), evTurn(t(11.3), SYSTEM, 'a0000005', 'end'),
    evTurn(t(10), C, 'a0000005', 'start'), evTurn(t(9.8), SYSTEM, 'a0000005', 'end'),
    evTurn(t(8), C, 'a0000005', 'start'), // open: runs to the bar end
  ];
  const costs = [];
  const turn = (id, h, mins) => costs.push({ ts: t(h), duration_ms: mins * M, sessionId: id });
  for (const [id, hs] of Object.entries({ a0000001: [58, 55, 52, 40], a0000002: [62, 60, 56, 48, 45, 42, 38, 36], a0000003: [48, 47], a0000004: [35, 34.5, 33], a0000005: [11.5, 10, 8], '1ead0001': [65, 63, 50], c0000001: [69, 60, 50, 29, 20, 14] })) {
    for (const h of hs) turn(id, h, 12);
  }
  const transcripts = {
    'cb-1': [
      toolUse('toolu_01', t(63), 'send_prompt', { sessionId: 'a0000002' }), toolResult('toolu_01', t(63)),
      toolUse('toolu_02', t(58) + 20_000, 'approve_plan', { sessionId: 'a0000002' }), toolResult('toolu_02', t(58)),
      toolUse('toolu_03', t(55), 'send_prompt', { sessionId: 'a0000001', forward: { sessionId: 'a0000002' } }), toolResult('toolu_03', t(55)),
      toolUse('toolu_04', t(52), 'send_prompt', { sessionId: 'a0000003' }), toolResult('toolu_04', t(52)),
      toolUse('toolu_05', t(51), 'reject_plan', { sessionId: 'a0000003' }), toolResult('toolu_05', t(51), false),
      wake('w-1', t(50.5), 'a0000002'), wake('w-2', t(49), 'a0000003'), wake('w-3', t(47), 'a0000001', true),
    ],
    'cb-2': [
      toolUse('toolu_06', t(28), 'send_prompt', { sessionId: 'a0000004' }), toolResult('toolu_06', t(28)),
      toolUse('toolu_07', t(24), 'answer_question', { sessionId: 'a0000004' }), toolResult('toolu_07', t(24)),
      toolUse('toolu_08', t(22), 'interrupt_turn', { sessionId: 'a0000004' }), toolResult('toolu_08', t(22)),
      wake('w-4', t(23), 'a0000004'),
      toolUse('toolu_09', t(10), 'send_prompt', { sessionId: 'a0000005' }), toolResult('toolu_09', t(10)), // after the cutoff: dropped
    ],
    'bk-lead': [
      toolUse('toolu_10', t(61), 'send_prompt', { sessionId: 'a0000001' }), toolResult('toolu_10', t(61)),
      wake('w-5', t(57), 'a0000001'),
    ],
  };
  return makeStore({ sessions, events, costs, transcripts });
}
