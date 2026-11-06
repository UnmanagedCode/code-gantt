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
// A fleet's coalesced deliveries stay far below MAX_WAKES_PER_LINE; the considered cap bounds the work
// non-id blocks can cause. Deliveries beyond either cap are counted, not silently lost.
const MAX_WAKES_PER_LINE = 500;
const MAX_BLOCKS_CONSIDERED = 2000;
// A quoted human line is always prefixed `>`, so a clause inside one never supplies a header.
const BODY_CUT = `\n${WAKE_BODY}`;
const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The text blocks of a content value (string, or array of strings / {text} blocks); non-text blocks give ''. */
function blocksOf(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''));
}

/** Text of a content value joined into one string. Never retained past the call. */
function textOf(content) {
  return blocksOf(content).join('\n');
}

/**
 * A delivery starts only at the very start of a content block: cc recognises a wake with
 * `startsWith(marker)` (shared/wakeCallback.ts parseWakeCallback), every stub it builds begins with the
 * marker, and coalesced deliveries are separate blocks of one line. A marker anywhere else (mid-line,
 * inside a quoted human prompt, inside a folded body) is text, not a delivery, and neither starts one nor
 * ends the enclosing header. A delivery's header runs to its `\n[[cc:wake-body]]` (or the block's end),
 * at most HEADER_MAX chars; nothing after the body separator is read. The worker is the first
 * `Worker \`id\`` clause on a header line that is not `>`-quoted (quoted lines are the human's words); the
 * heartbeat flag comes from the words right after that clause. Blocks beyond the caps are reported as one
 * `dropped` event.
 */
function wakes(blocks, line, ts) {
  const out = [];
  let considered = 0;
  let dropped = 0;
  blocks.forEach((text, index) => {
    if (!text.startsWith(WAKE)) return;
    if (out.length >= MAX_WAKES_PER_LINE || considered >= MAX_BLOCKS_CONSIDERED) {
      dropped++;
      return;
    }
    considered++;
    const head = text.slice(WAKE.length, WAKE.length + HEADER_MAX);
    const cut = head.indexOf(BODY_CUT);
    for (const l of (cut >= 0 ? head.slice(0, cut) : head).split('\n')) {
      if (l.startsWith('>')) continue;
      const m = WORKER_RE.exec(l);
      if (!m) continue;
      const ev = { k: 'wake', key: `${line.uuid ?? ''}#${index}`, ts, worker: m[1] };
      if (l.startsWith(' did NOT finish', m.index + m[0].length)) ev.heartbeat = true;
      out.push(ev);
      break;
    }
  });
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
 * @returns {({k:'call',id,ts,tool,target,forward?}|{k:'result',id,ok,ts}|{k:'wake',key,ts,worker,heartbeat?}|{k:'dropped',count})[]}
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
      for (const b of content) if (b?.type === 'tool_result' && CALL_ID_RE.test(b.tool_use_id ?? '')) out.push({ k: 'result', id: b.tool_use_id, ok: resultOk(b), ts });
    }
    out.push(...wakes(blocksOf(content), line, ts));
  } else if (line.type === 'attachment' && line.attachment?.type === 'queued_command') {
    out.push(...wakes(blocksOf(line.attachment.prompt), line, ts));
  }
  return out;
}
