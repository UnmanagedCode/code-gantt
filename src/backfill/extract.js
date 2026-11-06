import { GOVERNED_TOOLS } from '../model/linkTypes.js';

const MCP_PREFIX = 'mcp__code-conductor__';
const GOVERNED = new Set(GOVERNED_TOOLS);
const WAKE = '[[cc:wake-callback]]';
const WAKE_BODY = '[[cc:wake-body]]';
// Worker ids are 8-hex (optionally `-xxxx`) or a full UUID; anything else in backticks is not an id.
const WORKER_RE = /Worker `([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8}(?:-[0-9a-f]{4})?)`/;
const HEARTBEAT_RE = /did NOT finish/;
const HEADER_MAX = 600;
const MAX_MARKERS_PER_LINE = 50;
// starts alphanumeric so ids like __proto__ never become object keys
const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Text of a content value: string, or array of strings / {text} blocks. Never retained past the call. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n');
}

/**
 * One forward pass: each marker's header is the first line after it, bounded to HEADER_MAX chars
 * and cut at a body or following marker. Every search is bounded, and at most MAX_MARKERS_PER_LINE
 * markers are considered, so a hostile line cannot make the scan quadratic.
 */
function wakes(text, line, ts) {
  const out = [];
  let from = 0;
  let n = 0;
  for (let seen = 0; seen < MAX_MARKERS_PER_LINE; seen++) {
    const at = text.indexOf(WAKE, from);
    if (at < 0) break;
    const start = at + WAKE.length;
    from = start;
    const head = text.slice(start, start + HEADER_MAX);
    let end = head.length;
    for (const stop of ['\n', WAKE_BODY, WAKE]) {
      const i = head.indexOf(stop);
      if (i >= 0 && i < end) end = i;
    }
    const m = WORKER_RE.exec(head.slice(0, end));
    if (!m) continue;
    const ev = { k: 'wake', key: `${line.uuid ?? ''}#${n++}`, ts, worker: m[1] };
    if (HEARTBEAT_RE.test(head.slice(0, end))) ev.heartbeat = true;
    out.push(ev);
  }
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
 * @returns {({k:'call',id,ts,tool,target,forward?}|{k:'result',id,ok}|{k:'wake',key,ts,worker,heartbeat?})[]}
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
