import { el, svgEl, text, clear, listen } from '../lib/dom.js';
import { ticks, zoomAt, pan } from '../lib/scale.js';
import { ROW_H, HEADER_H } from '../lib/layout.js';
import { fmtTime, fmtDuration, labelOf } from '../lib/format.js';
import { endLabel } from './details.js';
import { attachBrush } from './brush.js';

export const LABEL_W = 250;
export const AXIS_H = 30;
const PAD_R = 14;
const STAGE_COLORS = 8;
const APPROX_TAIL_PX = 26;
// Drag state outlives a render: panning re-renders the svg on every move.
let dragX = null;

function stageIndex(stage) {
  let h = 0;
  for (const c of stage) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % STAGE_COLORS;
}

const trunc = (s, n) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

function linkLines(l, payload) {
  const a = payload.sessions[l.from];
  const b = payload.sessions[l.to];
  return [
    `${l.type}${l.heartbeat ? ' (heartbeat)' : ''}`,
    `${labelOf(a)} → ${labelOf(b)}`,
    fmtTime(l.ts),
  ];
}

function barLines(s) {
  return [
    labelOf(s),
    `${endLabel(s.endKind)}${s.endKind === 'approx' ? '' : s.endReason ? `: ${s.endReason}` : ''}`,
    `${fmtTime(s.start)} → ${s.end == null ? 'now' : fmtTime(s.end)}${s.end != null ? `  (${fmtDuration(s.end - s.start)})` : ''}`,
    `${s.turnCount} turns`,
  ];
}

/**
 * Builds the persistent chart frame inside `host` and returns `{ overlay, width(), render(opts) }`.
 * The frame is created once: a fixed time-scale box, a scroll container for the rows, and a pointer-transparent overlay on top.
 * `render` rebuilds only the svgs inside it (scale svg, rows svg) and clears the overlay, so the scroller and its offset survive.
 * `scale` maps time → pixels of the plot area (width = svg width − label column).
 * Wheel routing: over the time scale a plain wheel zooms; over the rows Ctrl/⌘+wheel (or pinch) zooms and a plain wheel scrolls.
 * The overlay holds the brush band and the tooltip, in the chart box's viewport coordinates.
 */
export function createChart(host) {
  const scaleBox = el('div', { class: 'chart-scale-box' });
  const scroller = el('div', { class: 'chart-scroll' });
  const overlay = svgEl('svg', { class: 'chart-overlay', 'aria-hidden': 'true' });
  host.append(scaleBox, scroller, overlay);
  return {
    overlay,
    width: () => scroller.clientWidth,
    render: (opts) => renderFrame({ scaleBox, scroller, overlay }, opts),
  };
}

function renderFrame({ scaleBox, scroller, overlay }, { payload, layout, scale, width, selectedId, bounds, emptyHint, onSelect, onHover, onLeave, onView, onBrush }) {
  const top = scroller.scrollTop;
  clear(overlay);
  const height = layout.height + 8;
  const X = (t) => LABEL_W + scale.x(t);
  const svg = svgEl('svg', { class: 'chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': 'Session timeline' });
  const scaleSvg = svgEl('svg', { class: 'chart-scale', width, height: AXIS_H, viewBox: `0 0 ${width} ${AXIS_H}`, role: 'group', 'aria-label': 'Time scale' });
  const plotXOf = (node) => (e) => e.clientX - node.getBoundingClientRect().left - LABEL_W;
  const plotW = width - LABEL_W - PAD_R;

  svg.appendChild(svgEl('defs', null,
    svgEl('pattern', { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      svgEl('rect', { width: 6, height: 6, class: 'hatch-bg' }), svgEl('rect', { width: 2.5, height: 6, class: 'hatch-line' })),
    svgEl('clipPath', { id: 'plot-clip' }, svgEl('rect', { x: LABEL_W, y: 0, width: plotW + PAD_R, height })),
  ));

  const body = svgEl('g');
  const plot = svgEl('g', { 'clip-path': 'url(#plot-clip)' });
  const labels = svgEl('g', { class: 'labels' });
  const axis = svgEl('g', { class: 'axis' });

  // stripes + labels + project headers
  const rowsHit = svgEl('rect', { class: 'plot-bg', x: LABEL_W, y: 0, width: plotW + PAD_R, height: layout.height });
  plot.appendChild(rowsHit);
  for (const r of layout.rows) {
    if (r.kind === 'project') {
      body.appendChild(svgEl('rect', { class: 'project-band', x: 0, y: r.y, width, height: HEADER_H }));
      labels.appendChild(svgEl('text', { class: 'project-label', x: 8, y: r.y + HEADER_H - 8 }, text(r.project)));
      continue;
    }
    const s = payload.sessions[r.id];
    body.appendChild(svgEl('rect', { class: `stripe${r.context ? ' context' : ''}`, x: 0, y: r.y, width, height: ROW_H }));
    labels.appendChild(svgEl('text', { class: `row-label${r.context ? ' context' : ''}`, x: 10 + r.depth * 12, y: r.y + ROW_H / 2 + 4 },
      text(trunc(labelOf(s), Math.floor((LABEL_W - 16 - r.depth * 12) / 6.4)))));
  }

  // axis + grid
  for (const t of ticks(scale)) {
    const x = X(t.t);
    plot.appendChild(svgEl('line', { class: 'grid', x1: x, x2: x, y1: 0, y2: layout.height }));
    axis.appendChild(svgEl('text', { x, y: AXIS_H - 9, 'text-anchor': 'middle' }, text(t.label)));
  }
  if (payload.now >= scale.from && payload.now <= scale.to) {
    plot.appendChild(svgEl('line', { class: 'now', x1: X(payload.now), x2: X(payload.now), y1: 0, y2: layout.height }));
  }

  // bars
  for (const r of layout.rows) {
    if (r.kind !== 'row') continue;
    const s = payload.sessions[r.id];
    const x0 = X(s.start);
    const x1 = X(s.end ?? payload.now);
    const w = Math.max(3, x1 - x0);
    const g = svgEl('g', { class: `bar-g${selectedId === s.id ? ' selected' : ''}${r.context ? ' context' : ''}`, 'data-id': s.id, role: 'button', tabindex: 0,
      'aria-label': `${labelOf(s)}: ${endLabel(s.endKind)}` });
    g.appendChild(svgEl('rect', { class: `bar bar-${s.endKind}`, x: x0, y: r.y + 4, width: w, height: ROW_H - 8, rx: 4 }));
    for (const st of s.stages) {
      const sx = X(st.from);
      const ex = X(st.to ?? s.end ?? payload.now);
      g.appendChild(svgEl('rect', { class: `stage stage-${stageIndex(st.stage)}`, 'data-stage': st.stage, x: sx, y: r.y + ROW_H - 9, width: Math.max(2, ex - sx), height: 4 }));
    }
    for (const [ts, te] of s.turns) {
      g.appendChild(svgEl('rect', { class: 'turn', x: X(ts), y: r.y + 8, width: Math.max(2, X(te) - X(ts)), height: ROW_H - 18, rx: 2 }));
    }
    if (s.endKind === 'approx') {
      const tw = Math.min(w, APPROX_TAIL_PX);
      g.appendChild(svgEl('rect', { class: 'approx-tail', role: 'img', 'aria-label': 'approximate end', x: x0 + w - tw, y: r.y + 4, width: tw, height: ROW_H - 8, rx: 4, fill: 'url(#hatch)' }));
    }
    for (const m of s.marks) {
      g.appendChild(svgEl('circle', { class: `mark mark-${m.kind}`, cx: X(m.at), cy: r.y + ROW_H / 2, r: 4 }));
    }
    for (const ro of s.rotations) {
      const cx = X(ro.at);
      const cy = r.y + ROW_H / 2;
      g.appendChild(svgEl('path', { class: `rotation rotation-${ro.reason}`, d: `M${cx} ${cy - 6} L${cx + 5} ${cy} L${cx} ${cy + 6} L${cx - 5} ${cy} Z` }));
    }
    listen(g, 'click', (e) => { e.stopPropagation(); onSelect(s.id); });
    listen(g, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(s.id); });
    const at = (e) => { const b = overlay.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    listen(g, 'mousemove', (e) => onHover(barLines(s), ...at(e)));
    listen(g, 'mouseleave', () => onLeave());
    plot.appendChild(g);
  }

  // links: a vertical connector at the event time, with an end dot on the target row.
  // Only the dot takes pointer events, so a connector never blocks clicks on the bars it crosses.
  const linkLayer = svgEl('g', { class: 'links' });
  for (const l of layout.links) {
    const x = X(l.ts);
    const lg = svgEl('g', { class: `link-g${l.heartbeat ? ' heartbeat' : ''}`, 'data-type': l.type });
    lg.appendChild(svgEl('line', { class: 'link', x1: x, x2: x, y1: l.y1, y2: l.y2 }));
    lg.appendChild(svgEl('circle', { class: 'link-end', cx: x, cy: l.y2, r: 3.5 }));
    lg.appendChild(svgEl('circle', { class: 'link-hit', cx: x, cy: l.y2, r: 7 }));
    const at = (e) => { const b = overlay.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    listen(lg, 'mousemove', (e) => onHover(linkLines(l, payload), ...at(e)));
    listen(lg, 'mouseleave', () => onLeave());
    linkLayer.appendChild(lg);
  }
  plot.appendChild(linkLayer);

  body.appendChild(plot);
  body.appendChild(labels);
  svg.appendChild(body);
  scaleSvg.appendChild(svgEl('rect', { class: 'axis-bg', x: 0, y: 0, width, height: AXIS_H }));
  scaleSvg.appendChild(axis);
  const axisHit = svgEl('rect', { class: 'axis-hit', x: LABEL_W, y: 0, width: plotW + PAD_R, height: AXIS_H },
    svgEl('title', null, text('Drag to zoom to an interval')));
  scaleSvg.appendChild(axisHit);
  attachBrush({ layer: overlay, hit: axisHit, scale, bounds, plotX: plotXOf(scaleSvg), left: LABEL_W, onBrush, onView });

  // wheel: the time scale always zooms; the rows zoom only with Ctrl/⌘ (pinch sends ctrlKey) and otherwise scroll natively
  const zoom = (e, px) => { e.preventDefault(); onView(zoomAt(scale, px(e), e.deltaY < 0 ? 1.25 : 0.8, bounds)); };
  listen(scaleSvg, 'wheel', (e) => zoom(e, plotXOf(scaleSvg)));
  listen(svg, 'wheel', (e) => { if (e.ctrlKey || e.metaKey) zoom(e, plotXOf(svg)); });

  // drag pan
  listen(rowsHit, 'mousedown', (e) => { dragX = e.clientX; });
  listen(svg, 'mousemove', (e) => {
    if (dragX == null) return;
    const dx = e.clientX - dragX;
    dragX = e.clientX;
    if (dx) onView(pan(scale, dx, bounds));
  });
  for (const t of ['mouseup', 'mouseleave']) listen(svg, t, () => { dragX = null; });

  scaleBox.replaceChildren(scaleSvg);
  scroller.replaceChildren(...(emptyHint ? [el('p', { class: 'empty-hint hint', role: 'status' }, emptyHint)] : []), svg);
  // browsers may clamp or anchor the offset while the content is swapped
  scroller.scrollTop = top;
}
