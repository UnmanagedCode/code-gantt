import test from 'node:test';
import assert from 'node:assert/strict';
import { timeScale, zoomAt, pan, ticks, readout, READOUT_SECONDS_MS_PER_PX, brushView, brushSpan, BRUSH_MIN_PX, MIN_SPAN_MS } from '../../public/lib/scale.js';

const bounds = { from: 0, to: 1_000_000 };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('x and invert are inverse over the domain', () => {
  const s = timeScale(1000, 3000, 500);
  assert.equal(s.x(1000), 0);
  assert.equal(s.x(3000), 500);
  near(s.invert(s.x(2345)), 2345);
});

test('zoomAt keeps the time under the cursor fixed', () => {
  const s = timeScale(200_000, 600_000, 800);
  const cursor = 300;
  const t = s.invert(cursor);
  const z = zoomAt(s, cursor, 2, bounds);
  near(z.invert(cursor), t);
  near(z.to - z.from, 200_000);
  const out = zoomAt(s, cursor, 0.5, bounds);
  near(out.invert(cursor), t);
});

test('zoom is clamped to the window and to a minimum span', () => {
  const s = timeScale(200_000, 600_000, 800);
  const out = zoomAt(s, 400, 0.0001, bounds);
  assert.ok(out.from >= bounds.from && out.to <= bounds.to);
  assert.equal(out.to - out.from, bounds.to - bounds.from);
  const inn = zoomAt(s, 400, 1e12, bounds);
  assert.ok(inn.to - inn.from >= 1000);
});

test('pan shifts content by dx pixels and is clamped to the window', () => {
  const s = timeScale(200_000, 600_000, 800);
  const t = 400_000;
  const p = pan(s, 100, bounds);
  near(p.x(t), s.x(t) + 100);
  const far = pan(s, 1e9, bounds);
  assert.equal(far.from, bounds.from);
  assert.equal(far.to - far.from, 400_000);
  const far2 = pan(s, -1e9, bounds);
  assert.equal(far2.to, bounds.to);
});

test('ticks are monotonic, inside the domain, and of a sensible count', () => {
  for (const [from, to] of [[0, 60_000], [1_700_000_000_000, 1_700_000_000_000 + 72 * 3600_000], [1_700_000_000_000, 1_700_000_000_000 + 14 * 86400_000]]) {
    const t = ticks(timeScale(from, to, 900));
    assert.ok(t.length >= 2 && t.length <= 16, String(t.length));
    for (let i = 0; i < t.length; i++) {
      assert.ok(t[i].t >= from && t[i].t <= to);
      if (i) assert.ok(t[i].t > t[i - 1].t);
      assert.equal(typeof t[i].label, 'string');
    }
  }
});

test('brushView maps a drag to the times under its ends', () => {
  const s = timeScale(0, 1_000_000, 500);
  const v = brushView(s, 100, 300, bounds);
  near(v.from, s.invert(100));
  near(v.to, s.invert(300));
  assert.equal(v.width, 500);
});

test('brushView gives the same interval for either drag direction', () => {
  const s = timeScale(0, 1_000_000, 500);
  const a = brushView(s, 100, 300, bounds);
  const b = brushView(s, 300, 100, bounds);
  assert.deepEqual([b.from, b.to, b.width], [a.from, a.to, a.width]);
});

test('brushView ignores a click and a drag below BRUSH_MIN_PX', () => {
  const s = timeScale(0, 1_000_000, 500);
  assert.equal(brushView(s, 200, 200, bounds), null);
  assert.equal(brushView(s, 200, 200 + BRUSH_MIN_PX - 1, bounds), null);
  assert.ok(brushView(s, 200, 200 + BRUSH_MIN_PX, bounds));
});

test('brushView clamps pixels outside the plot to its edges', () => {
  const s = timeScale(0, 1_000_000, 500);
  assert.equal(brushView(s, -50, 250, bounds).from, 0);
  assert.equal(brushView(s, 250, 900, bounds).to, 1_000_000);
  assert.equal(brushView(s, 600, 900, bounds), null);
  assert.equal(brushView(s, -90, -10, bounds), null);
});

test('brushView stays inside bounds when the view extends past them', () => {
  const s = timeScale(-500_000, 1_500_000, 500);
  const v = brushView(s, 0, 500, bounds);
  assert.ok(v.from >= bounds.from && v.to <= bounds.to);
  const w = brushView(s, 400, 500, bounds);
  assert.ok(w.from >= bounds.from && w.to <= bounds.to);
});

test('brushView widens a sub-minimum interval to MIN_SPAN_MS around its centre', () => {
  const s = timeScale(500_000, 500_000 + 2000, 500);
  const v = brushView(s, 100, 100 + BRUSH_MIN_PX, bounds);
  near(v.to - v.from, MIN_SPAN_MS);
  const mid = (s.invert(100) + s.invert(100 + BRUSH_MIN_PX)) / 2;
  near((v.from + v.to) / 2, mid);
  assert.ok(v.from >= bounds.from && v.to <= bounds.to);
});

test('brushSpan clamps and orders pixels', () => {
  const s = timeScale(0, 1000, 500);
  assert.deepEqual(brushSpan(s, 700, -20), { lo: 0, hi: 500 });
  assert.deepEqual(brushSpan(s, 300, 100), { lo: 100, hi: 300 });
});

test('brushView clamps times exactly at a bound when the view extends past it', () => {
  // 4000 ms per px; px 400..500 maps wholly beyond bounds.to, px 0..100 wholly before bounds.from.
  const s = timeScale(-500_000, 1_500_000, 500);
  const r = brushView(s, 400, 500, bounds);
  assert.equal(r.to, bounds.to);
  assert.equal(r.to - r.from, MIN_SPAN_MS);
  const l = brushView(s, 0, 100, bounds);
  assert.equal(l.from, bounds.from);
  assert.equal(l.to - l.from, MIN_SPAN_MS);
});

test('readout shows seconds iff one pixel spans at most READOUT_SECONDS_MS_PER_PX', () => {
  const t0 = new Date(2026, 0, 5, 13, 7, 9).getTime();
  const at = (spanMs) => readout(timeScale(t0, t0 + spanMs, 836), t0);
  const edge = READOUT_SECONDS_MS_PER_PX * 836;
  assert.match(at(edge), /^\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.match(at(edge + 1), /^\d\d-\d\d \d\d:\d\d$/);
});

test('readout digits are the local date fields of the time', () => {
  const t = new Date(2026, 10, 8, 3, 4, 5).getTime();
  assert.equal(readout(timeScale(t, t + 60_000, 836), t), '11-08 03:04:05');
  assert.equal(readout(timeScale(t, t + 86_400_000, 836), t), '11-08 03:04');
});

test('tick labels: daily steps show MM-DD, sub-day steps HH:MM except at local midnight which shows MM-DD', () => {
  const labels = (from, to) => ticks(timeScale(from, to, 900)).map((t) => t.label);
  const day = new Date(2026, 0, 5, 0, 0, 0).getTime();
  const days = labels(day, day + 14 * 86_400_000);
  assert.ok(days.length > 1 && days.every((l) => /^\d\d-\d\d$/.test(l)));
  assert.equal(days[0], '01-05');
  assert.deepEqual(labels(day, day + 86_400_000), ['01-05', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '01-06']);
  const hour = new Date(2026, 0, 5, 13, 0, 0).getTime();
  assert.deepEqual(labels(hour, hour + 3_600_000), ['13:00', '13:15', '13:30', '13:45', '14:00']);
});
