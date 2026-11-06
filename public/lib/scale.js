// Pure time-scale math: no DOM, so it is testable under plain Node.

const MIN_SPAN_MS = 1000;

export function timeScale(from, to, width) {
  const span = to - from;
  return {
    from, to, width,
    x: (t) => ((t - from) / span) * width,
    invert: (px) => from + (px / width) * span,
  };
}

function fit(from, span, bounds) {
  let f = from;
  if (f < bounds.from) f = bounds.from;
  if (f + span > bounds.to) f = bounds.to - span;
  return f;
}

/** Zoom by `factor` (>1 zooms in) around cursor pixel `cursorX`, keeping the time under it fixed. */
export function zoomAt(scale, cursorX, factor, bounds) {
  const maxSpan = bounds.to - bounds.from;
  const span = Math.min(maxSpan, Math.max(MIN_SPAN_MS, (scale.to - scale.from) / factor));
  const tc = scale.invert(cursorX);
  const from = fit(tc - (cursorX / scale.width) * span, span, bounds);
  return timeScale(from, from + span, scale.width);
}

/** Pan so content moves right by `dx` pixels, clamped to the bounds. */
export function pan(scale, dx, bounds) {
  const span = scale.to - scale.from;
  const from = fit(scale.from - (dx / scale.width) * span, span, bounds);
  return timeScale(from, from + span, scale.width);
}

const STEPS = [1, 5, 15, 30].map((s) => s * 1000)
  .concat([1, 5, 15, 30].map((m) => m * 60_000))
  .concat([1, 3, 6, 12].map((h) => h * 3_600_000))
  .concat([1, 2, 7, 14, 30].map((d) => d * 86_400_000));

const pad = (n) => String(n).padStart(2, '0');

/** Nice ticks (about `target`), aligned to local time. */
export function ticks(scale, target = 8) {
  const span = scale.to - scale.from;
  const step = STEPS.find((s) => span / s <= target) ?? STEPS.at(-1);
  const off = new Date(scale.from).getTimezoneOffset() * 60_000;
  const out = [];
  for (let t = Math.ceil((scale.from - off) / step) * step + off; t <= scale.to; t += step) {
    const d = new Date(t);
    const label = step >= 86_400_000
      ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      : step >= 3_600_000 && d.getHours() === 0 && d.getMinutes() === 0
        ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    out.push({ t, label });
  }
  return out;
}
