/**
 * Builds one session's bar. Pure: all inputs are precomputed by build.js.
 *
 * ctx: { own: ledger events with sessionId === this session (line order),
 *        namedMaxTs: latest ts of any ledger event naming it in any id field,
 *        turns: [[s,e]], turnRows, linkTs: latest link ts where it is an endpoint,
 *        kills: ts of kill_instance links targeting it, live: boolean, now }
 *
 * End precedence: killed/retired (see below) → live (end null; the frontend extends it to now)
 * → approx (latest of last turn end, ledger mention, link endpoint, segment start).
 * A kill counts when it follows the last resume. With a retire, it must also land no later than
 * KILL_AFTER_RETIRE_MS after it (either order of the two events); `end` stays the retire ts.
 * Any other retire after the last resume is `retired`.
 */
/** A kill interaction this soon after a retire still belongs to that retire. */
export const KILL_AFTER_RETIRE_MS = 5000;

export function buildBar(rec, ctx) {
  const segments = rec.segments ?? [];
  const start = Date.parse(segments[0]?.at) || 0;
  const own = ctx.own;

  let lastResumeIdx = -1;
  own.forEach((e, i) => { if (e.kind === 'resume') lastResumeIdx = i; });
  const lastResumeTs = lastResumeIdx >= 0 ? own[lastResumeIdx].ts : -Infinity;
  let retireIdx = -1;
  own.forEach((e, i) => { if (e.kind === 'retire' && i > lastResumeIdx) retireIdx = i; });
  const retire = retireIdx >= 0 ? own[retireIdx] : null;
  const afterResume = ctx.kills.filter((t) => t > lastResumeTs);
  // cc may write the retire first and the kill interaction a few ms later, or the reverse (transcript order).
  const kill = retire
    ? afterResume.filter((t) => t <= retire.ts + KILL_AFTER_RETIRE_MS).sort((a, b) => a - b).at(-1) ?? null
    : afterResume.sort((a, b) => a - b).at(-1) ?? null;

  let endKind;
  let end;
  let endReason;
  let endingRetire = null;
  if (kill != null) {
    endKind = 'killed';
    end = retire ? retire.ts : kill;
    if (retire) {
      endReason = retire.reason;
      endingRetire = retire;
    }
  } else if (retire) {
    endKind = 'retired';
    end = retire.ts;
    endReason = retire.reason;
    endingRetire = retire;
  } else if (ctx.live) {
    endKind = 'live';
    end = null;
  } else {
    endKind = 'approx';
    end = Math.max(start, ctx.turns.at(-1)?.[1] ?? 0, ctx.namedMaxTs, ctx.linkTs, ...segments.map((s) => Date.parse(s.at) || 0));
  }

  const spawn = own.find((e) => e.kind === 'spawn');
  const bands = [];
  if (spawn?.stage) bands.push({ stage: spawn.stage, from: spawn.ts });
  for (const e of own) if (e.kind === 'transition' && e.to) bands.push({ stage: e.to, from: e.ts, via: e.via });
  const stages = bands.map((b, i) => {
    const out = { stage: b.stage, from: b.from, to: bands[i + 1]?.from ?? end };
    if (b.via) out.via = b.via;
    return out;
  });

  const out = {
    id: rec.id,
    start, end, endKind,
    turns: ctx.turns,
    turnCount: rec.turnEndSeq ?? ctx.turnRows,
    rotations: segments
      .map((s, i) => ({ at: Date.parse(s.at), reason: s.reason, i }))
      .filter((s) => s.i > 0 && (s.reason === 'renew' || s.reason === 'prune'))
      .map(({ at, reason }) => ({ at, reason })),
    stages,
    marks: own.filter((e) => (e.kind === 'retire' || e.kind === 'resume') && e !== endingRetire).map((e) => ({ at: e.ts, kind: e.kind })),
  };
  if (endReason !== undefined) out.endReason = endReason;
  if (spawn?.playbook) out.playbook = spawn.playbook;
  return out;
}
