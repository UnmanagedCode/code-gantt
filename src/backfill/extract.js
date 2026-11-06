import { GOVERNED_TOOLS } from '../model/linkTypes.js';

const MCP_PREFIX = 'mcp__code-conductor__';
const GOVERNED = new Set(GOVERNED_TOOLS);
const WAKE = '[[cc:wake-callback]]';
const WAKE_BODY = '[[cc:wake-body]]';
// Worker ids are 8-hex (optionally `-xxxx`) or a full UUID; anything else in backticks is not an id.
const WORKER_RE = /Worker `([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8}(?:-[0-9a-f]{4})?)`/;
// Longest stub text before the `Worker \`id\`` clause, from cc's builders (shared/wakeCallback.ts
// buildWakeStub, src/promptAuthor.ts humanPromptsNote, src/idleSubscriptions.ts): the human note is a
// ~260-char notice, a ~75-char omission line and up to 3 quoted prompts. Each prompt is cut at 500 code
// points whose worst case is a newline each (`> ` + char + `\n` = 3 chars), plus a ~64-char cut suffix and
// a `\n>\n` separator; the decline and stale notes add ~150 + ~140. Total ≈ 5.4k, rounded up.
const HEADER_MAX = 8192;
// Ids a fleet can really produce stay far below MAX_WAKES_PER_LINE; the considered cap bounds the work
// that non-id markers can cause. Markers beyond either cap are counted, not silently lost.
const MAX_WAKES_PER_LINE = 500;
const MAX_MARKERS_CONSIDERED = 2000;
// A quoted human line is always prefixed `>`, so a marker or clause inside one never ends/supplies a header.
const BODY_CUT = `\n${WAKE_BODY}`;
const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Text of a content value: string, or array of strings / {text} blocks. Never retained past the call. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n');
}

/**
 * One forward pass over a line. A marker's header runs to the body separator or the next marker
 * (at most HEADER_MAX chars). The worker is the first `Worker \`id\`` clause on a line of the header
 * that is not `>`-quoted (quoted lines are the human's words); the heartbeat flag is taken from the
 * words right after that clause. Every search is bounded, so a hostile line cannot make the scan
 * quadratic. Markers beyond the caps are reported as one `dropped` event.
 */
function wakes(text, line, ts) {
  const out = [];
  let from = 0;
  let n = 0;
  let considered = 0;
  let dropped = 0;
  for (;;) {
    const at = text.indexOf(WAKE, from);
    if (at < 0) break;
    const start = at + WAKE.length;
    from = start;
    if (n >= MAX_WAKES_PER_LINE || considered >= MAX_MARKERS_CONSIDERED) {
      dropped++;
      continue;
    }
    considered++;
    const head = text.slice(start, start + HEADER_MAX);
    let end = head.length;
    for (const stop of [BODY_CUT, WAKE]) {
      const i = head.indexOf(stop);
      if (i >= 0 && i < end) end = i;
    }
    for (const l of head.slice(0, end).split('\n')) {
      if (l.startsWith('>')) continue;
      const m = WORKER_RE.exec(l);
      if (!m) continue;
      const ev = { k: 'wake', key: `${line.uuid ?? ''}#${n++}`, ts, worker: m[1] };
      if (l.startsWith(' did NOT finish', m.index + m[0].length)) ev.heartbeat = true;
      out.push(ev);
      break;
    }
  }
  if (dropped) out.push({ k: 'dropped', count: dropped });
  return out;
}

function resultOk(block) {
  if (block.is_error) return false;
  const t = textOf(block.content);
  if (t.startsWith('{')) {
    try {
      if (JSON.parse(t)?.ok === false) return false;
    } catch { /* not JSON: treat as ok */ }
  }
  return true;
}

/**
 * Pure per-line extractor. Emits only allowlisted fields (ids, tool, ts, heartbeat, ok);
 * no prompt text, wake body or tool_result text survives.
 * @returns {({k:'call',id,ts,tool,target,forward?}|{k:'result',id,ok}|{k:'wake',key,ts,worker,heartbeat?}|{k:'dropped',count})[]}
 */
export function extractLine(line) {
  if (!line || typeof line !== 'object') return [];
  const ts = Date.parse(line.timestamp);
  const out = [];
  if (line.type === 'assistant' && Array.isArray(line.message?.content)) {
    for (const b of line.message.content) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string' || !b.name.startsWith(MCP_PREFIX)) continue;
      const tool = b.name.slice(MCP_PREFIX.length);
      if (!GOVERNED.has(tool) || typeof b.input?.sessionId !== 'string' || !CALL_ID_RE.test(b.id ?? '')) continue;
      const ev = { k: 'call', id: b.id, ts, tool, target: b.input.sessionId };
      if (typeof b.input.forward?.sessionId === 'string') ev.forward = b.input.forward.sessionId;
      out.push(ev);
    }
  } else if (line.type === 'user') {
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_result' && CALL_ID_RE.test(b.tool_use_id ?? '')) out.push({ k: 'result', id: b.tool_use_id, ok: resultOk(b) });
    }
    const text = textOf(content);
    if (text.includes(WAKE)) out.push(...wakes(text, line, ts));
  } else if (line.type === 'attachment' && line.attachment?.type === 'queued_command') {
    const text = textOf(line.attachment.prompt);
    if (text.includes(WAKE)) out.push(...wakes(text, line, ts));
  }
  return out;
}
