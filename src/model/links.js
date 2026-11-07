import { resolveId } from './resolve.js';
import { GOVERNED_TOOLS, OTHER_LINK_TYPE } from './linkTypes.js';

const GOVERNED = new Set(GOVERNED_TOOLS);
// How far a backfill event's completion time (result line; transcript line for wakes) may sit from its
// event-log twin: the `call` row and the result line are both written after the handler returns.
const BOUNDARY_WINDOW_MS = 30_000;
const startOf = (rec) => Date.parse(rec.segments?.[0]?.at) || 0;

/**
 * Derives typed links from the cc store (sessions.json spawn edges, event-log rows) and from
 * the transcript backfill.
 *
 * - Backfill events at/after `cutoffTs` (the event log's first wake, or first call naming its caller)
 *   are dropped.
 * - A `call` row draws a link only when it is `ok`, is not `spawn_instance` (spawn edges come from
 *   sessions.json) and names its caller in `actor.sessionId`; an unattributed (migrated) row draws nothing.
 * - A `call` row whose tool is not governed becomes type `other` and is counted in `unknownTools`.
 *
 * `source: 'store'` marks every link derived from the cc store; `'backfill'` marks transcript-derived ones.
 */
export function buildLinks({ sessions, events, backfill, cutoffTs }) {
  const { byId, byBacking, forest } = sessions;
  const treeOf = new Map();
  for (const t of forest?.trees ?? []) {
    const ids = new Set(t.rows.map((r) => r.id));
    for (const id of ids) treeOf.set(id, ids);
  }
  let unresolved = 0;
  const unknownTools = new Map(); // tool names come from files: never a plain object
  // `count` (a boolean or a function) says whether a failed resolution is added to the diagnostic. It is
  // false for events whose event-log counterpart counts the same id already.
  const resolve = (raw, scopeId, count = true) => {
    const id = resolveId(raw, { byId, byBacking, scope: scopeId ? treeOf.get(scopeId) ?? null : null });
    if (!id && (typeof count === 'function' ? count() : count)) unresolved++;
    return id;
  };
  const links = [];
  const push = (l) => links.push(l);

  for (const [id, rec] of byId) {
    if (rec.parent && byId.has(rec.parent)) push({ ts: startOf(rec), type: 'spawn', from: rec.parent, to: id, source: 'store' });
  }

  const storeRefs = []; // event-log call/wake links a backfilled twin may duplicate
  const backfillCands = []; // surviving backfill links, pending boundary dedupe
  const typeOfTool = (tool) => {
    if (GOVERNED.has(tool)) return tool;
    unknownTools.set(tool ?? '', (unknownTools.get(tool ?? '') ?? 0) + 1);
    return OTHER_LINK_TYPE;
  };

  for (const ev of events) {
    if (!Number.isFinite(ev.ts)) continue;
    if (ev.kind === 'call') {
      if (ev.outcome !== 'ok' || ev.tool === 'spawn_instance' || !ev.actor.sessionId) continue;
      const to = resolve(ev.subject);
      const cond = resolve(ev.actor.sessionId, to);
      if (!to || !cond) continue;
      const tool = typeOfTool(ev.tool);
      let from = cond;
      let type = tool;
      if (ev.forward) {
        from = resolve(ev.forward, to);
        type = 'forward';
        if (!from) continue;
      }
      const link = { ts: ev.ts, type, from, to, source: 'store' };
      push(link);
      storeRefs.push(link);
    } else if (ev.kind === 'wake') {
      const worker = resolve(ev.subject);
      const cond = resolve(ev.recipient, worker);
      if (!worker || !cond) continue;
      const link = { ts: ev.ts, type: 'wake', from: worker, to: cond, source: 'store', ...(ev.heartbeat ? { heartbeat: true } : {}) };
      push(link);
      storeRefs.push(link);
    }
  }

  // A backfilled call's `ts` is its tool_use line (before the handler runs, minutes before for a parked
  // send_prompt); its `rts` is the tool_result line, written after the handler like the event-log row. All
  // cutoff and twin decisions use `et` = rts when known, so they do not depend on how long the handler took.
  const afterCutoff = (et) => cutoffTs != null && et >= cutoffTs;
  // The event-log row that would be a backfilled event's twin, and where it names each id. Only a row that
  // draws a link itself (attributed, ok, not a spawn) counts.
  const drawsCall = (ev) => ev.kind === 'call' && ev.outcome === 'ok' && ev.tool !== 'spawn_instance' && Boolean(ev.actor.sessionId);
  const FIELDS = {
    call: { target: (ev) => ev.subject, owner: (ev) => ev.actor.sessionId, forward: (ev) => ev.forward },
    wake: { target: (ev) => ev.subject, owner: (ev) => ev.recipient },
  };
  // A failed resolve of a pairable backfill event is not counted when an event-log row just after the cutoff
  // names that very raw id in the same field: the row counts it. Any other id of the event counts.
  const namedByTwin = (kind, field, rawId, et) => cutoffTs != null
    && events.some((ev) => ev.kind === kind && (kind === 'wake' || drawsCall(ev)) && FIELDS[kind][field](ev) === rawId && ev.ts >= cutoffTs && Math.abs(et - ev.ts) <= BOUNDARY_WINDOW_MS);
  const countUnless = (pairable, kind, field, rawId, et) => () => !afterCutoff(et) && !(pairable && namedByTwin(kind, field, rawId, et));
  for (const c of backfill.calls) {
    if (!c.ok) continue;
    const et = c.rts ?? c.ts;
    // cc appends the call row before the result line is written, so a call whose result is known and
    // landed at or after the cutoff always has its row: drop it before resolving anything.
    if (c.rts !== undefined && afterCutoff(et)) continue;
    // Every id of the call is resolved (and an unplaceable one counted) before deciding whether a link exists.
    const pairable = c.rts === undefined; // only such a call can still reach here after the cutoff
    const to = resolve(c.target, c.owner, countUnless(pairable, 'call', 'target', c.target, et));
    const owner = resolve(c.owner, undefined, countUnless(pairable, 'call', 'owner', c.owner, et));
    let from = owner;
    let type = typeOfTool(c.tool); // cached values are untrusted: anything ungoverned is `other`
    if (c.forward) {
      from = resolve(c.forward, c.owner, countUnless(pairable, 'call', 'forward', c.forward, et));
      type = 'forward';
    }
    if (!to || !from) continue;
    // Without a result time the tool_use time may precede the handler by minutes, so such a call can only
    // be matched to an event-log twin by pairing; with one, the cutoff rule above is exact and pairing would
    // only risk eating a genuine call.
    backfillCands.push({ link: { ts: c.ts, type, from, to, source: 'backfill' }, et, pairable });
  }
  for (const w of backfill.wakes) {
    const worker = resolve(w.worker, w.owner, countUnless(true, 'wake', 'target', w.worker, w.ts));
    const owner = resolve(w.owner, undefined, countUnless(true, 'wake', 'owner', w.owner, w.ts));
    if (!worker || !owner) continue;
    // wakes have no result line: their transcript time is all there is, so they are matched by pairing
    backfillCands.push({ link: { ts: w.ts, type: 'wake', from: worker, to: owner, source: 'backfill', ...(w.heartbeat ? { heartbeat: true } : {}) }, et: w.ts, pairable: true });
  }

  // Cutoff: the event log is authoritative from its first wake or attributed call. A backfill event that
  // completed at or after the cutoff is the log's; one that completed before it is kept, unless it is the
  // twin of a row written just after the cutoff. Twin pairing is one-to-one, nearest first, and applies
  // only to events whose time precedes their row by an unknown skew: wakes (transcript time) and
  // calls without a result time.
  const near = new Set();
  if (cutoffTs != null) {
    const poolBf = [];
    backfillCands.forEach((b, bi) => { if (b.pairable && b.et >= cutoffTs - BOUNDARY_WINDOW_MS && b.et <= cutoffTs + BOUNDARY_WINDOW_MS) poolBf.push(bi); });
    const poolStore = storeRefs.filter((l) => l.ts >= cutoffTs && l.ts <= cutoffTs + 2 * BOUNDARY_WINDOW_MS);
    const twins = [];
    for (const bi of poolBf) {
      const b = backfillCands[bi];
      poolStore.forEach((l, li) => {
        const dt = Math.abs(b.et - l.ts);
        if (b.link.type === l.type && b.link.from === l.from && b.link.to === l.to && Boolean(b.link.heartbeat) === Boolean(l.heartbeat) && dt <= BOUNDARY_WINDOW_MS) twins.push({ bi, li, dt });
      });
    }
    twins.sort((a, b) => a.dt - b.dt);
    const usedL = new Set();
    for (const t of twins) {
      if (usedL.has(t.li) || near.has(t.bi)) continue;
      usedL.add(t.li);
      near.add(t.bi);
    }
  }
  backfillCands.forEach((b, bi) => {
    if (near.has(bi)) return;
    if (cutoffTs != null && b.et >= cutoffTs) return;
    push(b.link);
  });

  links.sort((a, b) => a.ts - b.ts);
  return { links, unresolved, unknownTools: Object.fromEntries(unknownTools) };
}
