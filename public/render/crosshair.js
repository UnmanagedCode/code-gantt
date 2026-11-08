import { svgEl, text, listen } from '../lib/dom.js';
import { readout } from '../lib/scale.js';
import { CHAR_W } from './tooltip.js';

const PAD_X = 6;
const GAP = 8;
const PILL_H = 18;

/**
 * Hover crosshair for the time scale, drawn in `layer` (the chart overlay): a vertical line spanning the overlay and a time readout in the axis band.
 * Persistent: hover state lives on `host` because a render replaces the scale svg, and a removed node gets no `pointerleave`.
 * `update(view)` is called after every render with that render's `{ scale, hit, plotX, width }` and redraws at the remembered pointer.
 * Only moves whose target is the current `hit` count; during a brush drag the captured moves keep arriving there.
 */
export function createCrosshair({ host, layer, left, bandH }) {
  let clientX = null;
  let view = null;

  const draw = () => {
    for (const g of layer.querySelectorAll('g.crosshair')) g.remove();
    if (clientX == null || !view) return;
    const { scale, width } = view;
    const px = Math.min(scale.width, Math.max(0, view.plotX({ clientX })));
    const x = left + px;
    const label = readout(scale, scale.invert(px));
    const w = label.length * CHAR_W + 2 * PAD_X;
    let rx = x + GAP;
    if (rx + w > width) rx = x - GAP - w;
    const y = (bandH - PILL_H) / 2;
    layer.appendChild(svgEl('g', { class: 'crosshair', 'aria-hidden': 'true' },
      svgEl('line', { class: 'crosshair-line', x1: x, x2: x, y1: 0, y2: '100%' }),
      svgEl('g', { class: 'crosshair-readout' },
        svgEl('rect', { x: rx, y, width: w, height: PILL_H, rx: 3 }),
        svgEl('text', { x: rx + PAD_X, y: y + PILL_H - 5 }, text(label)))));
  };
  const hide = () => { clientX = null; draw(); };

  listen(host, 'pointermove', (e) => { clientX = view && e.target === view.hit ? e.clientX : null; draw(); });
  listen(host, 'pointerleave', hide);
  listen(host, 'pointerup', hide, true);
  listen(host, 'pointercancel', hide);

  return { update: (v) => { view = v; draw(); } };
}
