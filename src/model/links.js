import { resolveId } from './resolve.js';
import { GOVERNED_TOOLS, OTHER_LINK_TYPE } from './linkTypes.js';

const GOVERNED = new Set(GOVERNED_TOOLS);
const startOf = (rec) => Date.parse(rec.segments?.[0]?.at) || 0;

/**
 * Derives typed links from the cc store: spawn edges from sessions.json `parent`, and the event log's
 * `call` and `wake` rows.
 *
 * - A `call` row draws a link only when it is `ok`, is not `spawn_instance` (spawn edges come from
 *   sessions.json) and names its caller in `actor.sessionId`; an unattributed (migrated) row draws nothing.
 * - A `call` row with `forward` draws its tool link and a `forward` link (forward source → target) at the same
 *   `ts`; both carry `pair: { sender, source }`. An unresolvable forward source leaves the tool link unpaired.
 * - A `call` row whose tool is not governed becomes type `other` and is counted in `unknownTools`.
 * - An id that cannot be placed in sessions.json is counted in `unresolved`.
 */
export function buildLinks({ sessions, events }) {
  const { byId, byBacking, forest } = sessions;
  const treeOf = new Map();
  for (const t of forest?.trees ?? []) {
    const ids = new Set(t.rows.map((r) => r.id));
    for (const id of ids) treeOf.set(id, ids);
  }
  let unresolved = 0;
  const unknownTools = new Map(); // tool names come from files: never a plain object
  const resolve = (raw, scopeId) => {
    const id = resolveId(raw, { byId, byBacking, scope: scopeId ? treeOf.get(scopeId) ?? null : null });
    if (!id) unresolved++;
    return id;
  };
  const links = [];
  const typeOfTool = (tool) => {
    if (GOVERNED.has(tool)) return tool;
    unknownTools.set(tool ?? '', (unknownTools.get(tool ?? '') ?? 0) + 1);
    return OTHER_LINK_TYPE;
  };

  for (const [id, rec] of byId) {
    if (rec.parent && byId.has(rec.parent)) links.push({ ts: startOf(rec), type: 'spawn', from: rec.parent, to: id });
  }

  for (const ev of events) {
    if (!Number.isFinite(ev.ts)) continue;
    if (ev.kind === 'call') {
      if (ev.outcome !== 'ok' || ev.tool === 'spawn_instance' || !ev.actor.sessionId) continue;
      const to = resolve(ev.subject);
      const cond = resolve(ev.actor.sessionId, to);
      if (!to || !cond) continue;
      const tool = typeOfTool(ev.tool);
      const link = { ts: ev.ts, type: tool, from: cond, to };
      links.push(link);
      const source = ev.forward ? resolve(ev.forward, to) : null;
      if (source) {
        link.pair = { sender: cond, source };
        links.push({ ts: ev.ts, type: 'forward', from: source, to, pair: link.pair });
      }
    } else if (ev.kind === 'wake') {
      const worker = resolve(ev.subject);
      const cond = resolve(ev.recipient, worker);
      if (!worker || !cond) continue;
      links.push({ ts: ev.ts, type: 'wake', from: worker, to: cond, ...(ev.heartbeat ? { heartbeat: true } : {}) });
    }
  }

  links.sort((a, b) => a.ts - b.ts);
  return { links, unresolved, unknownTools: Object.fromEntries(unknownTools) };
}
