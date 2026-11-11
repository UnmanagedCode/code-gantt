// Pure time-scale math: no DOM, so it is testable under plain Node.

export const MIN_SPAN_MS = 1000;
export const BRUSH_MIN_PX = 4;

/** A wheel zoom anchored within this many plot pixels of the drawn right edge, or a brush whose right end lands there, is treated as being at that edge. */
export const LIVE_EDGE_PX = 4;

/** A result less than this many plot pixels short of the gesture bounds' right edge draws at that edge. */
const AT_EDGE_PX = 0.5;

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
  const cx = cursorX >= scale.width - LIVE_EDGE_PX ? scale.width : cursorX;
  const tc = scale.invert(cx);
  const from = fit(tc - (cx / scale.width) * span, span, bounds);
  return timeScale(from, from + span, scale.width);
}

/** Pan so content moves right by `dx` pixels, clamped to the bounds. */
export function pan(scale, dx, bounds) {
  const span = scale.to - scale.from;
  const from = fit(scale.from - (dx / scale.width) * span, span, bounds);
  return timeScale(from, from + span, scale.width);
}

/** Two pixel positions clamped to the plot `[0, scale.width]` and ordered. */
export function brushSpan(scale, x0, x1) {
  const c = (x) => Math.min(scale.width, Math.max(0, x));
  const a = c(x0);
  const b = c(x1);
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** The view for a brush from pixel `x0` to `x1`, or null when it is a click / jitter. */
export function brushView(scale, x0, x1, bounds) {
  const { lo, hi: rawHi } = brushSpan(scale, x0, x1);
  if (rawHi - lo < BRUSH_MIN_PX) return null;
  const hi = rawHi >= scale.width - LIVE_EDGE_PX ? scale.width : rawHi;
  const tLo = Math.max(bounds.from, scale.invert(lo));
  const tHi = Math.min(bounds.to, scale.invert(hi));
  const span = Math.min(bounds.to - bounds.from, Math.max(MIN_SPAN_MS, tHi - tLo));
  const from = fit((tLo + tHi) / 2 - span / 2, span, bounds);
  return timeScale(from, from + span, scale.width);
}

/**
 * A view that follows "now": its left edge stays and its right edge moves to `window.to`.
 * Null when the left edge is at or before `window.from`: that is the default view, which follows already.
 */
export function followNow(view, window) {
  if (view.from <= window.from) return null;
  return { from: view.from, to: window.to, live: true };
}

/**
 * The stored view for a gesture result `s` drawn against `gestureBounds`: live (ending at `current.to`)
 * when `s` reaches the right edge of `gestureBounds`, else frozen as given.
 */
export function settleView(s, gestureBounds, current) {
  const pxMs = (s.to - s.from) / s.width;
  if (gestureBounds.to - s.to < AT_EDGE_PX * pxMs) return followNow({ from: s.from, to: s.to }, current);
  return { from: s.from, to: s.to, live: false };
}

const STEPS = [1, 5, 15, 30].map((s) => s * 1000)
  .concat([1, 5, 15, 30].map((m) => m * 60_000))
  .concat([1, 3, 6, 12].map((h) => h * 3_600_000))
  .concat([1, 2, 7, 14, 30].map((d) => d * 86_400_000));

const pad = (n) => String(n).padStart(2, '0');

const md = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Readout seconds are shown once one plot pixel spans at most this many ms. */
export const READOUT_SECONDS_MS_PER_PX = 1000;

/** Local `MM-DD HH:MM` of time `t`, plus `:SS` when the scale resolves seconds. */
export function readout(scale, t) {
  const d = new Date(t);
  const sec = (scale.to - scale.from) / scale.width <= READOUT_SECONDS_MS_PER_PX ? `:${pad(d.getSeconds())}` : '';
  return `${md(d)} ${hm(d)}${sec}`;
}

/** Nice ticks (about `target`), aligned to local time. */
export function ticks(scale, target = 8) {
  const span = scale.to - scale.from;
  const step = STEPS.find((s) => span / s <= target) ?? STEPS.at(-1);
  const off = new Date(scale.from).getTimezoneOffset() * 60_000;
  const out = [];
  for (let t = Math.ceil((scale.from - off) / step) * step + off; t <= scale.to; t += step) {
    const d = new Date(t);
    const label = step >= 86_400_000 || (step >= 3_600_000 && d.getHours() === 0 && d.getMinutes() === 0) ? md(d) : hm(d);
    out.push({ t, label });
  }
  return out;
}
