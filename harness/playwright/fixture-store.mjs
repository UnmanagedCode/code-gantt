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
    cond0001: { ...sess({ id: 'cond0001', title: 'Conductor', backing: 'cb-1', segments: [seg('cb-1', 'initial', t(70)), seg('cb-2', 'renew', t(30))] }), current: 'cb-2' },
    lead0001: sess({ id: 'lead0001', title: 'Alpha lead', parent: 'cond0001', project: 'alpha', conducted: true, at: iso(t(66)), backing: 'bk-lead' }),
    wkr00001: sess({ id: 'wkr00001', title: 'Beta worker (under lead)', parent: 'lead0001', project: 'beta', worktree: 'feat-b', conducted: true, at: iso(t(60)), backing: 'bk-1' }),
    wkr00002: { ...sess({ id: 'wkr00002', title: 'Alpha implementer', parent: 'cond0001', project: 'alpha', worktree: 'feat-a', conducted: true, turnEndSeq: 14, backing: 'bk-2',
      segments: [seg('bk-2', 'initial', t(64)), seg('bk-2b', 'renew', t(44)), seg('bk-2c', 'prune', t(40))] }), backend: { backend: 'claude', model: 'claude-opus-5-5' } },
    wkr00003: sess({ id: 'wkr00003', title: 'Alpha killed worker', parent: 'cond0001', project: 'alpha', conducted: true, at: iso(t(50)), backing: 'bk-3' }),
    wkr00004: sess({ id: 'wkr00004', title: 'Beta approx-end worker', parent: 'cond0001', project: 'beta', conducted: true, at: iso(t(36)), backing: 'bk-4' }),
    wkr00005: sess({ id: 'wkr00005', title: 'Beta recent worker', parent: 'cond0001', project: 'beta', conducted: true, at: iso(t(12)), backing: 'bk-5' }),
  };
  const ev = (h, o) => ({ ts: iso(t(h)), ...o });
  const ledger = [
    ev(66, { kind: 'spawn', sessionId: 'lead0001', playbook: 'split', stage: 'plan' }),
    ev(64, { kind: 'spawn', sessionId: 'wkr00002', playbook: 'classic', stage: 'plan' }),
    ev(60, { kind: 'spawn', sessionId: 'wkr00001', playbook: 'classic', stage: 'implement' }),
    ev(58, { kind: 'transition', sessionId: 'wkr00002', from: 'plan', to: 'implement', via: 'approve_plan' }),
    ev(50, { kind: 'spawn', sessionId: 'wkr00003', playbook: 'classic', stage: 'implement' }),
    ev(46, { kind: 'transition', sessionId: 'wkr00002', from: 'implement', to: 'review', via: 'send_prompt', forwardSessionId: 'wkr00001' }),
    ev(36, { kind: 'spawn', sessionId: 'wkr00004', playbook: 'classic', stage: 'plan' }),
    ev(34, { kind: 'retire', sessionId: 'wkr00002', reason: 'stage complete' }),
    ev(30, { kind: 'retire', sessionId: 'wkr00001', reason: 'subprocess exited' }),
    ev(20, { kind: 'interaction', conductorSessionId: 'cond0001', sessionId: 'wkr00003', tool: 'kill_instance' }),
    ev(19, { kind: 'retire', sessionId: 'wkr00003', reason: 'killed' }),
    ev(15, { kind: 'wake', conductorSessionId: 'cond0001', sessionId: 'wkr00005' }),
    ev(14, { kind: 'wake', conductorSessionId: 'cond0001', sessionId: 'wkr00005', heartbeat: true }),
    ev(13, { kind: 'interaction', conductorSessionId: 'cond0001', sessionId: 'wkr00005', tool: 'set_mode' }),
    ev(11, { kind: 'interaction', conductorSessionId: 'cond0001', sessionId: 'wkr00005', tool: 'frobnicate' }),
    ev(9, { kind: 'refusal', tool: 'spawn_instance' }),
  ];
  const costs = [];
  const turn = (id, h, mins) => costs.push({ ts: t(h), duration_ms: mins * M, sessionId: id });
  for (const [id, hs] of Object.entries({ wkr00001: [58, 55, 52, 40], wkr00002: [62, 60, 56, 48, 45, 42, 38, 36], wkr00003: [48, 47], wkr00004: [35, 34.5, 33], wkr00005: [11.5, 10, 8], lead0001: [65, 63, 50], cond0001: [69, 60, 50, 29, 20, 14] })) {
    for (const h of hs) turn(id, h, 12);
  }
  const transcripts = {
    'cb-1': [
      toolUse('toolu_01', t(63), 'send_prompt', { sessionId: 'wkr00002' }), toolResult('toolu_01', t(63)),
      toolUse('toolu_02', t(58) + 20_000, 'approve_plan', { sessionId: 'wkr00002' }), toolResult('toolu_02', t(58)),
      toolUse('toolu_03', t(55), 'send_prompt', { sessionId: 'wkr00001', forward: { sessionId: 'wkr00002' } }), toolResult('toolu_03', t(55)),
      toolUse('toolu_04', t(52), 'send_prompt', { sessionId: 'wkr00003' }), toolResult('toolu_04', t(52)),
      toolUse('toolu_05', t(51), 'reject_plan', { sessionId: 'wkr00003' }), toolResult('toolu_05', t(51), false),
      wake('w-1', t(50.5), 'wkr00002'), wake('w-2', t(49), 'wkr00003'), wake('w-3', t(47), 'wkr00001', true),
    ],
    'cb-2': [
      toolUse('toolu_06', t(28), 'send_prompt', { sessionId: 'wkr00004' }), toolResult('toolu_06', t(28)),
      toolUse('toolu_07', t(24), 'answer_question', { sessionId: 'wkr00004' }), toolResult('toolu_07', t(24)),
      toolUse('toolu_08', t(22), 'interrupt_turn', { sessionId: 'wkr00004' }), toolResult('toolu_08', t(22)),
      wake('w-4', t(23), 'wkr00004'),
      toolUse('toolu_09', t(10), 'send_prompt', { sessionId: 'wkr00005' }), toolResult('toolu_09', t(10)), // after the cutoff: dropped
    ],
    'bk-lead': [
      toolUse('toolu_10', t(61), 'send_prompt', { sessionId: 'wkr00001' }), toolResult('toolu_10', t(61)),
      wake('w-5', t(57), 'wkr00001'),
    ],
  };
  return makeStore({ sessions, ledger, costs, transcripts });
}
