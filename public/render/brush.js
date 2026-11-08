import { svgEl, listen, unlisten } from '../lib/dom.js';
import { brushSpan, brushView } from '../lib/scale.js';

/**
 * Drag-to-zoom on the time scale. `hit` is the capture target; `plotX(e)` maps an event to plot pixels.
 * `onBrush(active)` brackets a gesture so the host can defer renders; `onView(scale)` receives the committed view.
 * `scale` and `bounds` are those the visible svg was drawn with.
 * The band is drawn in `layer` (the chart overlay) and spans its full height: the time scale plus the visible rows.
 */
export function attachBrush({ layer, hit, scale, bounds, plotX, left, onBrush, onView }) {
  let g = null;

  const draw = () => {
    const { lo, hi } = brushSpan(scale, g.x0, g.x1);
    g.band.setAttribute('x', String(left + lo));
    g.band.setAttribute('width', String(hi - lo));
  };

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    finish(false);
  };

  function finish(commit) {
    if (!g) return;
    const { id, x0, x1, band } = g;
    g = null;
    band.remove();
    unlisten(document, 'keydown', onKey);
    if (hit.hasPointerCapture?.(id)) hit.releasePointerCapture(id);
    const next = commit ? brushView(scale, x0, x1, bounds) : null;
    onBrush?.(false);
    if (next) onView(next);
  }

  listen(hit, 'pointerdown', (e) => {
    if (g || !e.isPrimary || e.button !== 0) return;
    const x = plotX(e);
    const band = svgEl('rect', { class: 'brush-band', x: left, y: 0, width: 0, height: '100%' });
    layer.appendChild(band);
    g = { id: e.pointerId, x0: x, x1: x, band };
    hit.setPointerCapture?.(e.pointerId);
    listen(document, 'keydown', onKey);
    onBrush?.(true);
    draw();
  });
  listen(hit, 'pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    g.x1 = plotX(e);
    draw();
  });
  listen(hit, 'pointerup', (e) => {
    if (!g || e.pointerId !== g.id) return;
    g.x1 = plotX(e);
    finish(true);
  });
  for (const t of ['pointercancel', 'lostpointercapture']) {
    listen(hit, t, (e) => { if (g && e.pointerId === g.id) finish(false); });
  }
}
