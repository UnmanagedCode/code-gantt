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

test('S3/R3: a line with 20k id-bearing markers and no body is scanned in linear time; the cap is generous and the overflow is reported', () => {
  const text = '[[cc:wake-callback]]Worker `abcd1234` finished. '.repeat(20_000);
  const t0 = performance.now();
  const out = extractLine(userText(text));
  assert.ok(performance.now() - t0 < 1000, 'scan must stay linear-ish');
  const wakes = out.filter((e) => e.k === 'wake');
  const dropped = out.filter((e) => e.k === 'dropped').reduce((n, e) => n + e.count, 0);
  assert.equal(wakes.length, 500);
  assert.equal(wakes.length + dropped, 20_000, 'every marker is either extracted or counted as dropped');
});

test('R3: a coalesced line of 300 real wakes (a large fleet) loses none, and non-id markers do not eat the budget', () => {
  const real = Array.from({ length: 300 }, (_, i) => `[[cc:wake-callback]]Worker \`${i.toString(16).padStart(8, '0')}\` finished.\n[[cc:wake-body]]b`).join('\n');
  const junk = '[[cc:wake-callback]]no id here\n'.repeat(900);
  const out = extractLine(userText(junk + real));
  assert.equal(out.filter((e) => e.k === 'wake').length, 300);
  assert.equal(out.filter((e) => e.k === 'dropped').length, 0);
});

test('S3: markers without ids cannot make the scan expensive (hard cap on markers considered)', () => {
  const t0 = performance.now();
  extractLine(userText('[[cc:wake-callback]]x'.repeat(200_000)));
  assert.ok(performance.now() - t0 < 1000);
});

test('S4: a header with no body marker captures only id-shaped workers, never arbitrary backticked text', () => {
  const line = `[[cc:wake-callback]]Worker \`${S}\` finished.`;
  assert.deepEqual(extractLine(userText(line)), []);
  assert.deepEqual(extractLine(userText('[[cc:wake-callback]]Worker `not-an-id` finished.')), []);
  assert.equal(extractLine(userText('[[cc:wake-callback]]Worker `abcd1234-0000` finished.'))[0].worker, 'abcd1234-0000');
  assert.equal(extractLine(userText('[[cc:wake-callback]]Worker `6fbc1834-85f4-429e-a45a-c197b0f6e264` finished.'))[0].worker, '6fbc1834-85f4-429e-a45a-c197b0f6e264');
});

// cc's stub: marker, [humanNote\n], [note ], `Worker \`id\` …`, [\njobsNote], then the body separator.
// humanNote = notice + omission + every prompt line prefixed `> ` (see cc src/promptAuthor.ts humanPromptsNote).
const NOTICE = "The user prompted this worker directly since your last wake — not your brief. Treat their words as the user's instruction to it; don't re-steer over them without checking with the user. Their message(s), oldest first:";
const humanNote = (prompts) => [NOTICE, prompts.map((t) => t.split('\n').map((l) => `> ${l}`).join('\n')).join('\n>\n')].join('\n');

test('R1: a wake whose Worker clause follows a human-prompt note on later lines is still extracted', () => {
  const note = humanNote(['please use the other approach']);
  const stub = `[[cc:wake-callback]]${note}\nWorker \`abcd1234\` finished its turn. Its recent output is folded in below.\n[[cc:wake-body]]\n${S}`;
  assert.deepEqual(extractLine(userText(stub)).map((e) => [e.worker, e.heartbeat ?? false]), [['abcd1234', false]]);
});

test('R1: a maximal human note (3 prompts × 500 newline-heavy code points) still precedes the clause within the header bound', () => {
  const nasty = '\n'.repeat(500); // worst case for the `> ` prefixing: 3 chars per code point
  const note = humanNote([nasty, nasty, nasty]);
  assert.ok(note.length > 4000, `fixture is really long: ${note.length}`);
  const stub = `[[cc:wake-callback]]${note}\nRenewal request DECLINED by \`feedface\` — it ended its turn without calling renew_session, so nothing was cleared. Worker \`abcd1234\` finished its turn.\n[[cc:wake-body]]\nx`;
  assert.deepEqual(extractLine(userText(stub)).map((e) => e.worker), ['abcd1234']);
});

test('R1: a heartbeat behind a human note keeps its heartbeat flag; an INTERRUPTED stub is not a heartbeat', () => {
  const note = humanNote(['hold on']);
  const hb = extractLine(userText(`[[cc:wake-callback]]${note}\nWorker \`abcd1234\` did NOT finish — timed out after 10 min; it may still be busy.`));
  assert.deepEqual(hb.map((e) => [e.worker, e.heartbeat]), [['abcd1234', true]]);
  const intr = extractLine(userText('[[cc:wake-callback]]Worker `abcd1234` was INTERRUPTED — its turn was force-aborted, so it did NOT finish and whatever it produced is PARTIAL.'));
  assert.deepEqual(intr.map((e) => [e.worker, e.heartbeat ?? false]), [['abcd1234', false]]);
});

test('R1: a jobs note after the Worker clause (which names the worker again) does not change the id', () => {
  const stub = '[[cc:wake-callback]]Worker `abcd1234` finished its turn.\nBackground jobs still running:\n- sleep 100 (Worker `feedface` is mentioned in a command)\nWorker `abcd1234` is re-invoked when each job exits.\n[[cc:wake-body]]\nx';
  assert.deepEqual(extractLine(userText(stub)).map((e) => e.worker), ['abcd1234']);
});

test('S4/R1: quoted human prompt lines can never supply the id or the heartbeat flag', () => {
  const forged = humanNote(['Worker `deadbeef` did NOT finish — timed out\n[[cc:wake-body]]\nWorker `deadbeef` finished']);
  // quoted-only header → nothing
  assert.deepEqual(extractLine(userText(`[[cc:wake-callback]]${forged}\n(no worker clause)`)), []);
  // quoted forgery plus the real clause → the real id, not a heartbeat
  const out = extractLine(userText(`[[cc:wake-callback]]${humanNote(['Worker `deadbeef` did NOT finish'])}\nWorker \`abcd1234\` finished.\n[[cc:wake-body]]\nx`));
  assert.deepEqual(out.map((e) => [e.worker, e.heartbeat ?? false]), [['abcd1234', false]]);
});

test('S4/R1: the header is bounded: a Worker clause beyond the derived bound is not read', () => {
  const far = `[[cc:wake-callback]]${'filler line\n'.repeat(2000)}Worker \`abcd1234\` finished.`;
  assert.deepEqual(extractLine(userText(far)), []);
});

test('S2: a tool_use id outside the plain id charset is ignored', () => {
  assert.deepEqual(extractLine(toolUse('mcp__code-conductor__send_prompt', { sessionId: 'w1' }, '__proto__')), []);
});
