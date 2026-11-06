import test from 'node:test';
import assert from 'node:assert/strict';
import { timeScale, zoomAt, pan, ticks } from '../../public/lib/scale.js';

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
