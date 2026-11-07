// A rich synthetic cc store for the golden-path harness (times are relative to "now").
// The horizon falls mid-fixture, at the first `turn` row (28h ago; the first wake is just before it):
// one tree lies wholly before it, a2 spans it (with a pre-horizon bind, rotations and marks).
import { makeStore, sess, iso, evCall, evSession, evTurn, evWake, SYSTEM, HUMAN } from '../../tests/helpers/store.mjs';

const H = 3600_000;

export function buildFixture(now = Date.now()) {
  const t = (hoursAgo) => now - hoursAgo * H;
  const seg = (id, reason, at) => ({ id, reason, at: iso(at) });
  const sessions = {
    c0000001: { ...sess({ id: 'c0000001', title: 'Conductor', backing: 'cb-1', segments: [seg('cb-1', 'initial', t(70)), seg('cb-2', 'renew', t(30))] }), current: 'cb-2' },
    '1ead0001': sess({ id: '1ead0001', title: 'Alpha lead', parent: 'c0000001', project: 'alpha', conducted: true, at: iso(t(66)), backing: 'bk-lead' }),
    a0000001: sess({ id: 'a0000001', title: 'Beta worker (under lead)', parent: '1ead0001', project: 'beta', worktree: 'feat-b', conducted: true, at: iso(t(60)), backing: 'bk-1' }),
    a0000002: { ...sess({ id: 'a0000002', title: 'Alpha implementer', parent: 'c0000001', project: 'alpha', worktree: 'feat-a', conducted: true, turnEndSeq: 14, backing: 'bk-2',
      segments: [seg('bk-2', 'initial', t(64)), seg('bk-2b', 'renew', t(44)), seg('bk-2c', 'prune', t(40)), seg('bk-2d', 'renew', t(23.9))] }), backend: { backend: 'claude', model: 'claude-opus-5-5' } },
    a0000003: sess({ id: 'a0000003', title: 'Alpha killed worker', parent: 'c0000001', project: 'alpha', conducted: true, at: iso(t(50)), backing: 'bk-3' }),
    a0000004: sess({ id: 'a0000004', title: 'Beta approx-end worker', parent: 'c0000001', project: 'beta', conducted: true, at: iso(t(36)), backing: 'bk-4' }),
    a0000005: sess({ id: 'a0000005', title: 'Beta recent worker', parent: 'c0000001', project: 'beta', conducted: true, at: iso(t(12)), backing: 'bk-5' }),
    c0000002: sess({ id: 'c0000002', title: 'Old conductor', at: iso(t(46)), backing: 'cb-old' }),
    a0000006: sess({ id: 'a0000006', title: 'Gamma old worker', parent: 'c0000002', project: 'gamma', conducted: true, at: iso(t(45)), backing: 'bk-6' }),
  };
  const migrated = { type: 'conductor' }; // migrated calls carry no caller
  const C = 'c0000001';
  const events = [
    evCall(t(66), migrated, '1ead0001', 'spawn_instance', { bind: { playbook: 'split', stage: 'plan' } }),
    evCall(t(64), migrated, 'a0000002', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
    evCall(t(60), migrated, 'a0000001', 'spawn_instance', { bind: { playbook: 'classic', stage: 'implement' } }),
    evCall(t(58), migrated, 'a0000002', 'approve_plan', { move: { from: 'plan', to: 'implement' } }),
    evCall(t(50), migrated, 'a0000003', 'spawn_instance', { bind: { playbook: 'classic', stage: 'implement' } }),
    evCall(t(46), migrated, 'a0000002', 'send_prompt', { forward: 'a0000001', move: { from: 'implement', to: 'review' } }),
    evCall(t(45), migrated, 'a0000006', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
    evSession(t(41), SYSTEM, 'a0000006', 'exit', { cause: 'exited' }),
    evSession(t(40.1), SYSTEM, 'a0000002', 'exit', { cause: 'exited' }),
    evSession(t(40), SYSTEM, 'a0000002', 'resume', { cause: 'prune' }),
    evCall(t(36), migrated, 'a0000004', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
    // a conductor-initiated exit before the horizon: a1 (and so its lead) is not shown
    evSession(t(30), { type: 'conductor', sessionId: C }, 'a0000001', 'exit', { cause: 'exited' }),
    evWake(t(29), 'a0000002', C), // first wake: links are complete from here
    evTurn(t(28), HUMAN, C, 'start'), evTurn(t(27.6), SYSTEM, C, 'end'), // first turn row: the horizon
    evCall(t(27), migrated, 'a0000004', 'send_prompt'), // no caller: draws nothing
    evTurn(t(27.5), C, 'a0000003', 'start'), evTurn(t(27.2), SYSTEM, 'a0000003', 'end'),
    evTurn(t(26), C, 'a0000004', 'start'), evTurn(t(25.8), SYSTEM, 'a0000004', 'end'),
    evSession(t(24), SYSTEM, 'a0000002', 'exit', { cause: 'exited' }),
    evSession(t(23.9), SYSTEM, 'a0000002', 'resume', { cause: 'renew' }),
    evCall(t(22.5), C, 'a0000002', 'send_prompt', { forward: 'a0000004' }),
    evTurn(t(22), C, 'a0000002', 'start'), evTurn(t(21.7), SYSTEM, 'a0000002', 'end'),
    evCall(t(21), C, 'a0000002', 'approve_plan', { move: { from: 'review', to: 'done' } }),
    evTurn(t(18), HUMAN, C, 'start'), evTurn(t(17.6), SYSTEM, C, 'end'),
    // a system exit followed by the kill_instance call
    evSession(t(19), SYSTEM, 'a0000003', 'exit', { cause: 'exited' }),
    evCall(t(19) + 8, C, 'a0000003', 'kill_instance'),
    evWake(t(15), 'a0000005', C),
    evWake(t(14), 'a0000005', C, { heartbeat: true }),
    evCall(t(13), C, 'a0000005', 'set_mode'),
    evCall(t(12), C, 'a0000005', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
    evCall(t(11), C, 'a0000005', 'frobnicate'),
    evTurn(t(11.5), C, 'a0000005', 'start'), evTurn(t(11.3), SYSTEM, 'a0000005', 'end'),
    evCall(t(10.5), C, 'a0000005', 'send_prompt', { move: { from: 'plan', to: 'implement' } }),
    evTurn(t(10), C, 'a0000005', 'start'), evTurn(t(9.8), SYSTEM, 'a0000005', 'end'),
    evCall(t(9.5), C, undefined, 'spawn_instance', { outcome: 'refused' }),
    evCall(t(9), C, 'a0000005', 'approve_plan', { move: { from: 'implement', to: 'review' } }),
    evTurn(t(8), C, 'a0000005', 'start'), // open: runs to the bar end
  ];
  return makeStore({ sessions, events });
}
