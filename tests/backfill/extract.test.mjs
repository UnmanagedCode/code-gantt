import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLine } from '../../src/backfill/extract.js';
import { GOVERNED_TOOLS } from '../../src/model/linkTypes.js';
import { PROMPT_SENTINEL as S } from '../helpers/sentinel.mjs';

const TS = '2026-11-01T10:00:00.000Z';
const toolUse = (name, input, id = 'toolu_1') => ({
  type: 'assistant', timestamp: TS, uuid: 'u1',
  message: { content: [{ type: 'text', text: S }, { type: 'tool_use', id, name, input }] },
});
const userText = (text, extra = {}) => ({ type: 'user', timestamp: TS, uuid: 'u2', message: { content: [{ type: 'text', text }] }, ...extra });
const wakeHeader = (id) => `[[cc:wake-callback]]Worker \`${id}\` finished its turn. Its recent output follows.\n[[cc:wake-body]]${S}`;

test('governed send_prompt tool_use → call with bare tool, raw target, raw forward id', () => {
  const out = extractLine(toolUse('mcp__code-conductor__send_prompt', { sessionId: 'aaaa1111', text: S, forward: { sessionId: 'f1' } }));
  assert.deepEqual(out, [{ k: 'call', id: 'toolu_1', ts: Date.parse(TS), tool: 'send_prompt', target: 'aaaa1111', forward: 'f1' }]);
});

test('every governed tool is extracted (parity with the ledger interaction set)', () => {
  for (const tool of GOVERNED_TOOLS) {
    const out = extractLine(toolUse(`mcp__code-conductor__${tool}`, { sessionId: 'aaaa1111' }));
    assert.equal(out.length, 1, tool);
    assert.equal(out[0].tool, tool);
  }
});

test('non-governed cc tools and non-cc tools yield nothing', () => {
  for (const n of ['mcp__code-conductor__describe_session', 'mcp__code-conductor__spawn_instance', 'mcp__code-conductor__list_sessions', 'Bash', 'mcp__other__send_prompt']) {
    assert.deepEqual(extractLine(toolUse(n, { sessionId: 'aaaa1111' })), [], n);
  }
});

test('tool_result is_error or ok:false JSON → ok:false; otherwise ok:true', () => {
  const res = (block) => extractLine({ type: 'user', timestamp: TS, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', ...block }] } });
  assert.deepEqual(res({ is_error: true, content: [{ type: 'text', text: 'boom ' + S }] }), [{ k: 'result', id: 'toolu_1', ok: false }]);
  assert.deepEqual(res({ content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'X', note: S }) }] }), [{ k: 'result', id: 'toolu_1', ok: false }]);
  assert.deepEqual(res({ content: [{ type: 'text', text: JSON.stringify({ ok: true, note: S }) }] }), [{ k: 'result', id: 'toolu_1', ok: true }]);
  assert.deepEqual(res({ content: 'plain text result' }), [{ k: 'result', id: 'toolu_1', ok: true }]);
});

test('user wake lines with array and string content → wake', () => {
  const a = extractLine(userText(wakeHeader('abcd1234')));
  assert.deepEqual(a, [{ k: 'wake', key: 'u2#0', ts: Date.parse(TS), worker: 'abcd1234' }]);
  const b = extractLine({ type: 'user', timestamp: TS, uuid: 'u3', message: { content: wakeHeader('abcd1234') } });
  assert.equal(b.length, 1);
  assert.equal(b[0].worker, 'abcd1234');
});

test('attachment queued_command wake (array and string prompt) → wake', () => {
  const att = (prompt) => ({ type: 'attachment', timestamp: TS, uuid: 'u4', attachment: { type: 'queued_command', prompt } });
  assert.equal(extractLine(att(wakeHeader('aaaa1111')))[0].worker, 'aaaa1111');
  assert.equal(extractLine(att([{ type: 'text', text: wakeHeader('bbbb2222') }]))[0].worker, 'bbbb2222');
  assert.deepEqual(extractLine({ type: 'attachment', timestamp: TS, uuid: 'u5', attachment: { type: 'other', prompt: wakeHeader('cccc3333') } }), []);
});

test('a line with 3 markers → 3 wakes keyed by marker index; text before the marker is fine', () => {
  const text = `preface\n${wakeHeader('a1a1a1a1')}\n${wakeHeader('b2b2b2b2')}\n${wakeHeader('c3c3c3c3')}`;
  const out = extractLine(userText(text));
  assert.deepEqual(out.map((w) => [w.key, w.worker]), [['u2#0', 'a1a1a1a1'], ['u2#1', 'b2b2b2b2'], ['u2#2', 'c3c3c3c3']]);
});

test('heartbeat header → heartbeat:true', () => {
  const out = extractLine(userText('[[cc:wake-callback]]Worker `a0a0a0a0` did NOT finish — timed out after 600s.\n[[cc:wake-body]]x'));
  assert.deepEqual(out.map((w) => [w.worker, w.heartbeat]), [['a0a0a0a0', true]]);
});

test('a backticked id inside the body after the wake-body marker is not taken', () => {
  const out = extractLine(userText('[[cc:wake-callback]]Worker `beef0001` finished.\n[[cc:wake-body]]see Worker `feedface` and `other`'));
  assert.deepEqual(out.map((w) => w.worker), ['beef0001']);
  assert.deepEqual(extractLine(userText('[[cc:wake-callback]]no worker named here\n[[cc:wake-body]]Worker `feedface`')), []);
});

test('queue-operation, last-prompt, api-request-blob and assistant lines quoting the marker → nothing', () => {
  const m = wakeHeader('0a0a0a0a');
  assert.deepEqual(extractLine({ type: 'queue-operation', operation: 'remove', content: m, timestamp: TS }), []);
  assert.deepEqual(extractLine({ type: 'last-prompt', lastPrompt: m }), []);
  assert.deepEqual(extractLine({ type: 'api-request-blob', blob: m }), []);
  assert.deepEqual(extractLine({ type: 'assistant', timestamp: TS, uuid: 'x', message: { content: [{ type: 'text', text: m }] } }), []);
});

test('no extracted event contains the prompt sentinel', () => {
  const all = [
    ...extractLine(toolUse('mcp__code-conductor__send_prompt', { sessionId: 'aaaa1111', text: S, feedback: S, answers: [S] })),
    ...extractLine(userText(wakeHeader('aaaa1111'))),
    ...extractLine({ type: 'user', timestamp: TS, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: S }] }] } }),
  ];
  assert.ok(all.length >= 3);
  assert.equal(JSON.stringify(all).includes(S), false);
});
