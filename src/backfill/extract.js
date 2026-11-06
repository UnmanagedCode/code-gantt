import { GOVERNED_TOOLS } from '../model/linkTypes.js';

const MCP_PREFIX = 'mcp__code-conductor__';
const GOVERNED = new Set(GOVERNED_TOOLS);
const WAKE = '[[cc:wake-callback]]';
const WAKE_BODY = '[[cc:wake-body]]';
const WORKER_RE = /Worker `([^`]+)`/;
const HEARTBEAT_RE = /did NOT finish/;
const HEADER_MAX = 600;

/** Text of a content value: string, or array of strings / {text} blocks. Never retained past the call. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n');
}

function wakes(text, line, ts) {
  const out = [];
  let from = 0;
  let n = 0;
  for (;;) {
    const at = text.indexOf(WAKE, from);
    if (at < 0) break;
    const start = at + WAKE.length;
    const nextMarker = text.indexOf(WAKE, start);
    const body = text.indexOf(WAKE_BODY, start);
    let end = Math.min(...[body, nextMarker, start + HEADER_MAX].filter((x) => x >= 0));
    const header = text.slice(start, end);
    from = start;
    const m = WORKER_RE.exec(header);
    if (!m) continue;
    const ev = { k: 'wake', key: `${line.uuid ?? ''}#${n++}`, ts, worker: m[1] };
    if (HEARTBEAT_RE.test(header)) ev.heartbeat = true;
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
      if (!GOVERNED.has(tool) || typeof b.input?.sessionId !== 'string') continue;
      const ev = { k: 'call', id: b.id, ts, tool, target: b.input.sessionId };
      if (typeof b.input.forward?.sessionId === 'string') ev.forward = b.input.forward.sessionId;
      out.push(ev);
    }
  } else if (line.type === 'user') {
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') out.push({ k: 'result', id: b.tool_use_id, ok: resultOk(b) });
    }
    const text = textOf(content);
    if (text.includes(WAKE)) out.push(...wakes(text, line, ts));
  } else if (line.type === 'attachment' && line.attachment?.type === 'queued_command') {
    const text = textOf(line.attachment.prompt);
    if (text.includes(WAKE)) out.push(...wakes(text, line, ts));
  }
  return out;
}
