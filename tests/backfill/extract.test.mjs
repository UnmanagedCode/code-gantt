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

test('S3: a line with 20k wake markers and no body marker is scanned in linear time and capped', () => {
  const text = '[[cc:wake-callback]]Worker `abcd1234` finished. '.repeat(20_000);
  const t0 = performance.now();
  const out = extractLine(userText(text));
  assert.ok(performance.now() - t0 < 1000, 'scan must stay linear-ish');
  assert.ok(out.length > 0 && out.length <= 100, `capped, got ${out.length}`);
});

test('S3: markers at different distances scale linearly (10x input is not ~100x slower)', () => {
  const run = (n) => { const t = performance.now(); extractLine(userText('[[cc:wake-callback]]x'.repeat(n))); return performance.now() - t; };
  run(1000); // warm up
  const small = Math.max(run(5000), 0.5);
  const big = run(50_000);
  assert.ok(big < small * 40 + 50, `small ${small}ms big ${big}ms`);
});

test('S4: a header with no body marker captures only id-shaped workers, never arbitrary backticked text', () => {
  const line = `[[cc:wake-callback]]Worker \`${S}\` finished.`;
  assert.deepEqual(extractLine(userText(line)), []);
  assert.deepEqual(extractLine(userText('[[cc:wake-callback]]Worker `not-an-id` finished.')), []);
  assert.equal(extractLine(userText('[[cc:wake-callback]]Worker `abcd1234-0000` finished.'))[0].worker, 'abcd1234-0000');
  assert.equal(extractLine(userText('[[cc:wake-callback]]Worker `6fbc1834-85f4-429e-a45a-c197b0f6e264` finished.'))[0].worker, '6fbc1834-85f4-429e-a45a-c197b0f6e264');
});

test('S4: the header ends at the first newline, so a worker named on a later line is not taken', () => {
  assert.deepEqual(extractLine(userText('[[cc:wake-callback]]nothing here\nWorker `abcd1234` is mentioned below')), []);
});

test('S2: a tool_use id outside the plain id charset is ignored', () => {
  assert.deepEqual(extractLine(toolUse('mcp__code-conductor__send_prompt', { sessionId: 'w1' }, '__proto__')), []);
});
