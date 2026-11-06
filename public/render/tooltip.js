import { svgEl, text, clear } from '../lib/dom.js';

const CHAR_W = 6.6;
const LINE_H = 15;

/** SVG-native tooltip (inline style is blocked by CSP, so it is positioned with a transform attribute). */
export function showTooltip(svg, lines, x, y) {
  hideTooltip(svg);
  const width = Math.max(...lines.map((l) => l.length)) * CHAR_W + 14;
  const height = lines.length * LINE_H + 10;
  const vb = svg.viewBox.baseVal;
  const maxX = (vb?.width || 1000) - width - 4;
  const tx = Math.max(4, Math.min(x + 12, maxX));
  const ty = Math.max(4, y + 14 + height > (vb?.height || 1000) ? y - height - 8 : y + 14);
  const g = svgEl('g', { class: 'tooltip', transform: `translate(${tx} ${ty})`, 'pointer-events': 'none', role: 'tooltip' },
    svgEl('rect', { width, height, rx: 4 }));
  lines.forEach((l, i) => g.appendChild(svgEl('text', { x: 7, y: 5 + (i + 1) * LINE_H - 4 }, text(l))));
  svg.appendChild(g);
}

export function hideTooltip(svg) {
  for (const g of svg.querySelectorAll('g.tooltip')) {
    clear(g);
    g.remove();
  }
}
