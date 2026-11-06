import { el, clear, text, listen } from './lib/dom.js';
import { timeScale } from './lib/scale.js';
import { applyFilters, defaultFilters } from './lib/layout.js';
import { renderChart, LABEL_W } from './render/chart.js';
import { renderFilters } from './render/filters.js';
import { renderDetails } from './render/details.js';
import { showTooltip, hideTooltip } from './render/tooltip.js';

const DEFAULT_RANGE_MS = 72 * 3600_000;
const DEFAULT_WIDTH = 1100;
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Wiring only: owns state, fetches the payload, calls the render modules.
 * `api.getJson(path)` and `api.subscribe(onVersion)` are injected so tests need no network.
 */
export function mount(root, api) {
  const state = { payload: null, filters: null, view: null, selected: null, rangeMs: DEFAULT_RANGE_MS };

  const banner = el('div', { class: 'banner', role: 'status' });
  const filtersHost = el('div', { class: 'filters' });
  const chartHost = el('div', { class: 'chart-host' });
  const details = el('section', { id: 'details', role: 'region', 'aria-label': 'Session details' });
  const diag = el('footer', { class: 'diagnostics' });
  clear(root);
  root.append(banner, filtersHost, el('div', { class: 'main' }, chartHost, details), diag);

  const bounds = () => state.payload.window;

  function render() {
    const p = state.payload;
    if (!p) return;
    const d = p.diagnostics;
    clear(banner);
    if (d.backfill.state === 'scanning') banner.appendChild(text(`Backfilling interactions from transcripts… ${d.backfill.filesDone}/${d.backfill.filesTotal} files`));
    clear(diag);
    diag.appendChild(text([
      `liveness: ${d.liveness}${d.liveness === 'unavailable' ? ' (no open-ended bars)' : ''}`,
      `backfill cutoff: ${d.cutoff ?? 'none'}`,
      `unresolved ids: ${d.unresolved}`,
      `unknown ledger kinds: ${Object.values(d.unknownKinds).reduce((a, b) => a + b, 0)}`,
      `unknown tools (shown as other): ${Object.values(d.unknownTools).reduce((a, b) => a + b, 0)}`,
      `corrupt lines: ${d.corruptLines}`,
      d.missing.length ? `missing: ${d.missing.join(', ')}` : null,
      ...d.errors,
    ].filter(Boolean).join('  ·  ')));

    renderFilters(filtersHost, p, state.filters, state.rangeMs, {
      onChange: render,
      onRange: (ms) => { state.rangeMs = ms; state.view = null; load(); },
      onResetZoom: () => { state.view = null; render(); },
    });
    const width = chartHost.clientWidth || DEFAULT_WIDTH;
    const plotW = Math.max(100, width - LABEL_W - 14);
    const v = state.view ?? p.window;
    const scale = timeScale(v.from, v.to, plotW);
    const layout = applyFilters(p, state.filters);
    const svg = renderChart(chartHost, {
      payload: p, layout, scale, width, bounds: bounds(), selectedId: state.selected,
      onSelect: (id) => { state.selected = id; hideTooltip(svg); render(); },
      onHover: (lines, x, y) => showTooltip(svg, lines, x, y),
      onLeave: () => hideTooltip(svg),
      onView: (s) => { state.view = { from: s.from, to: s.to }; render(); },
    });
    renderDetails(details, state.selected ? p.sessions[state.selected] ?? null : null);
  }

  async function load() {
    const to = Date.now();
    const p = await api.getJson(`api/gantt?from=${to - state.rangeMs}&to=${to}`);
    const prev = state.filters;
    state.filters = defaultFilters(p);
    if (prev) {
      // keep the user's choices; new link types default to on
      state.filters.projects = prev.projects;
      state.filters.roots = prev.roots;
      state.filters.heartbeat = prev.heartbeat;
      state.filters.linkTypes = new Set(p.linkTypes.filter((t) => prev.linkTypes.has(t) || !prevTypes.has(t)));
    }
    prevTypes = new Set(p.linkTypes);
    state.payload = p;
    render();
  }
  let prevTypes = new Set();

  let timer = null;
  api.subscribe?.(() => {
    clearTimeout(timer);
    timer = setTimeout(() => load().catch((e) => console.error(e)), REFRESH_DEBOUNCE_MS);
  });
  if (typeof window !== 'undefined') listen(window, 'resize', () => render());

  return { state, load, render };
}
