// A rich synthetic cc store for the golden-path harness (times are relative to "now").
import { makeStore, sess, iso } from '../../tests/helpers/store.mjs';

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
  const ev = (h, o) => ({ ts: iso(t(h)), ...o });
  const ledger = [
    ev(66, { kind: 'spawn', sessionId: '1ead0001', playbook: 'split', stage: 'plan' }),
    ev(64, { kind: 'spawn', sessionId: 'a0000002', playbook: 'classic', stage: 'plan' }),
    ev(60, { kind: 'spawn', sessionId: 'a0000001', playbook: 'classic', stage: 'implement' }),
    ev(58, { kind: 'transition', sessionId: 'a0000002', from: 'plan', to: 'implement', via: 'approve_plan' }),
    ev(50, { kind: 'spawn', sessionId: 'a0000003', playbook: 'classic', stage: 'implement' }),
    ev(46, { kind: 'transition', sessionId: 'a0000002', from: 'implement', to: 'review', via: 'send_prompt', forwardSessionId: 'a0000001' }),
    ev(36, { kind: 'spawn', sessionId: 'a0000004', playbook: 'classic', stage: 'plan' }),
    ev(34, { kind: 'retire', sessionId: 'a0000002', reason: 'stage complete' }),
    ev(30, { kind: 'retire', sessionId: 'a0000001', reason: 'subprocess exited' }),
    // cc writes the retire first, then the kill interaction a few ms later
    ev(19, { kind: 'retire', sessionId: 'a0000003', reason: 'killed' }),
    { ts: iso(t(19) + 8), kind: 'interaction', conductorSessionId: 'c0000001', sessionId: 'a0000003', tool: 'kill_instance' },
    ev(15, { kind: 'wake', conductorSessionId: 'c0000001', sessionId: 'a0000005' }),
    ev(14, { kind: 'wake', conductorSessionId: 'c0000001', sessionId: 'a0000005', heartbeat: true }),
    ev(13, { kind: 'interaction', conductorSessionId: 'c0000001', sessionId: 'a0000005', tool: 'set_mode' }),
    ev(11, { kind: 'interaction', conductorSessionId: 'c0000001', sessionId: 'a0000005', tool: 'frobnicate' }),
    ev(9, { kind: 'refusal', tool: 'spawn_instance' }),
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
  return makeStore({ sessions, ledger, costs, transcripts });
}
