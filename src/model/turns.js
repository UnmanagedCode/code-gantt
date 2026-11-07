/**
 * Folds `turn` rows into per-session intervals. Pure.
 *
 * `events` are EventLogReader rows in line order; `idOf` maps a raw subject to a public id (or falsy).
 * Returns Map<publicId, [start, end|null][]>; `null` is a turn still open at the end of the log.
 * A `start` while a turn is open closes it at the new start; an `end` with no open turn is ignored; a
 * `session` row of the same subject closes an open turn at its ts (a reboot writes no closing `end`).
 */
export function buildTurns(events, idOf) {
  const out = new Map();
  const open = new Map();
  const close = (id, at) => {
    const s = open.get(id);
    if (s === undefined) return;
    open.delete(id);
    out.get(id).push([s, at]);
  };
  for (const ev of events) {
    if ((ev.kind !== 'turn' && ev.kind !== 'session') || !Number.isFinite(ev.ts)) continue;
    const id = ev.subject && idOf(ev.subject);
    if (!id) continue;
    if (!out.has(id)) out.set(id, []);
    if (ev.kind === 'session') close(id, ev.ts);
    else if (ev.event === 'start') {
      close(id, ev.ts);
      open.set(id, ev.ts);
    } else if (ev.event === 'end') close(id, ev.ts);
  }
  for (const [id, s] of open) out.get(id).push([s, null]);
  for (const [id, list] of out) if (!list.length) out.delete(id);
  return out;
}
