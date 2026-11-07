/**
 * Builds one session's bar. Pure: all inputs are precomputed by build.js.
 *
 * ctx: { own: this session's event-log rows in line order: `session` rows and `call` rows carrying
 *        `bind` or `move`,
 *        namedMaxTs: latest ts of any event-log row naming it in any id field,
 *        turns: [[s,e]], turnRows, linkTs: latest link ts where it is an endpoint,
 *        kills: ts of kill_instance links targeting it, live: boolean, now }
 *
 * End precedence: killed/exited (see below) → live (end null; the frontend extends it to now)
 * → approx (latest of last turn end, event-log mention, link endpoint, segment start).
 * The ending row is the last `session` `exit` after the last `start`/`resume`. An exit whose actor is a
 * conductor (kill_instance) or a human (UI kill) is `killed`. Any other exit is `killed` only when a
 * kill_instance link lands within KILL_AFTER_EXIT_MS of it (either order); otherwise it is `exited`
 * (`end` = the exit ts, `endReason` = its cause). A kill link after the last life began, with no exit,
 * is `killed` at the kill ts.
 */
/** A kill_instance link this soon before or after a system exit still belongs to that exit. */
export const KILL_AFTER_EXIT_MS = 5000;

export function buildBar(rec, ctx) {
  const segments = rec.segments ?? [];
  const start = Date.parse(segments[0]?.at) || 0;
  const own = ctx.own;

  let lastLifeIdx = -1;
  own.forEach((e, i) => { if (e.kind === 'session' && (e.event === 'start' || e.event === 'resume')) lastLifeIdx = i; });
  const lastLifeTs = lastLifeIdx >= 0 ? own[lastLifeIdx].ts : -Infinity;
  let exitIdx = -1;
  own.forEach((e, i) => { if (e.kind === 'session' && e.event === 'exit' && i > lastLifeIdx) exitIdx = i; });
  const exit = exitIdx >= 0 ? own[exitIdx] : null;
  const afterLife = ctx.kills.filter((t) => t > lastLifeTs);
  // cc writes the exit first and the kill_instance call right after it; either order is accepted.
  const kill = exit
    ? afterLife.filter((t) => Math.abs(t - exit.ts) <= KILL_AFTER_EXIT_MS).sort((a, b) => a - b).at(-1) ?? null
    : afterLife.sort((a, b) => a - b).at(-1) ?? null;

  let endKind;
  let end;
  let endReason;
  let endingExit = null;
  if (exit && (exit.actor.type !== 'system' || kill != null)) {
    endKind = 'killed';
    end = exit.ts;
    endingExit = exit;
    if (exit.cause !== undefined) endReason = exit.cause;
  } else if (exit) {
    endKind = 'exited';
    end = exit.ts;
    endingExit = exit;
    if (exit.cause !== undefined) endReason = exit.cause;
  } else if (kill != null) {
    endKind = 'killed';
    end = kill;
  } else if (ctx.live) {
    endKind = 'live';
    end = null;
  } else {
    endKind = 'approx';
    end = Math.max(start, ctx.turns.at(-1)?.[1] ?? 0, ctx.namedMaxTs, ctx.linkTs, ...segments.map((s) => Date.parse(s.at) || 0));
  }

  // `bind` replaces the bands (and the playbook); a `move` to the stage already held folds nothing.
  let bands = [];
  let playbook;
  for (const e of own) {
    if (e.kind !== 'call') continue;
    if (e.bind) {
      bands = [{ stage: e.bind.stage, from: e.ts }];
      playbook = e.bind.playbook;
    } else if (e.move && e.move.to !== bands.at(-1)?.stage) {
      bands.push({ stage: e.move.to, from: e.ts, via: e.tool });
    }
  }
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
    marks: own
      .filter((e) => e.kind === 'session' && (e.event === 'exit' || e.event === 'resume') && e !== endingExit)
      .map((e) => ({ at: e.ts, kind: e.event })),
  };
  if (endReason !== undefined) out.endReason = endReason;
  if (playbook) out.playbook = playbook;
  return out;
}

/**
 * Clips a built bar to the horizon `h` (ms). Pure; the bar itself is always built from the whole log.
 * A bar that ends at or after `h` starts at `h` and keeps only the marks, rotations and stage bands from
 * `h` on; the stage held at `h` is carried in as a band starting at `h`. A bar that ends before `h` keeps
 * its start and end but draws nothing.
 */
export function clipToHorizon(bar, h) {
  if (bar.end != null && bar.end < h) return { ...bar, marks: [], rotations: [], stages: [], turns: [] };
  return {
    ...bar,
    start: Math.max(bar.start, h),
    marks: bar.marks.filter((m) => m.at >= h),
    rotations: bar.rotations.filter((r) => r.at >= h),
    stages: bar.stages
      .filter((s) => s.to == null || s.to > h)
      .map((s) => (s.from < h ? { ...s, from: h } : s)),
  };
}
