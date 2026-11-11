// Renders the REAL cc store, read-only by construction:
//  - safety tests must pass first (source scan + before/after snapshot test),
//  - the plugin has no write path.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';
import { applyFilters, defaultFilters } from '../../public/lib/layout.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });

// 1. preconditions
const safety = spawnSync('node', ['--test', '--test-concurrency=1', 'tests/safety/*.test.mjs'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !['PROJECTS_ROOT', 'CONDUCTOR_URL'].includes(k))),
});
if (safety.status !== 0) throw new Error('safety tests failed: refusing to boot against the real store');

const projectsRoot = process.env.CC_PROJECTS_ROOT;
if (!projectsRoot) throw new Error('CC_PROJECTS_ROOT is not set');

const { bootServer, withPage } = await import(BROWSER);
const SESSION_KEYS = new Set(['id', 'title', 'project', 'worktree', 'model', 'playbook', 'parent', 'orphan', 'start', 'end', 'endKind', 'endReason', 'turns', 'turnCount', 'rotations', 'stages', 'marks']);
const LINK_KEYS = new Set(['ts', 'type', 'from', 'to', 'heartbeat', 'pair']);

let srv;
try {
  srv = await bootServer({
    cwd: repoRoot,
    entry: 'server.js',
    env: { PROJECTS_ROOT: projectsRoot },
  });
  const get = async (q) => (await fetch(`${srv.url}/api/gantt${q}`)).json();
  const payload = await get('');
  const horizon = payload.diagnostics.horizon;
  console.log(`horizon: ${horizon}`);
  assert.ok(horizon, 'the real event log has a horizon');
  const horizonMs = Date.parse(horizon);

  const wide = await get(`?from=${Date.now() - 30 * 86400_000}&to=${Date.now()}`);
  assert.ok(wide.trees.length >= 1, 'at least one tree');
  assert.equal(wide.window.from, horizonMs, 'a window before the horizon is clamped to it');
  assert.ok(wide.links.every((l) => l.ts >= horizonMs), 'every link is at or after the horizon');
  for (const p of [payload, wide]) {
    for (const s of Object.values(p.sessions)) assert.deepEqual(Object.keys(s).filter((k) => !SESSION_KEYS.has(k)), [], 'session keys');
    for (const l of p.links) assert.deepEqual(Object.keys(l).filter((k) => !LINK_KEYS.has(k)), [], 'link keys');
  }
  // Links are drawn inside one section, and a section lies within one band; a link whose ends share no section is stubs, so no line spans two bands.
  const layout = applyFilters(wide, defaultFilters(wide));
  const bands = layout.rows.filter((r) => r.kind === 'band').map((r) => r.y);
  const bandOf = (y) => bands.filter((b) => b <= y).length - 1;
  for (const l of layout.links) assert.equal(bandOf(l.y1), bandOf(l.y2), `link ${l.type} ${l.from}→${l.to} spans two bands`);
  const crossForwards = layout.stubs.filter((s) => s.type === 'forward' && s.end === 'source').length;
  console.log(`layout: ${bands.length} bands, ${layout.links.length} links drawn, ${layout.stubs.length / 2} cross-band links as stubs (${crossForwards} forwards)`);
  console.log(`30d window: ${wide.trees.length} trees, ${Object.keys(wide.sessions).length} sessions, ${wide.links.length} links; diagnostics ${JSON.stringify(wide.diagnostics)}`);

  await withPage(async (page) => {
    await page.goto(srv.url);
    await page.waitForSelector('svg.chart');
    await page.screenshot({ path: path.join(shots, 'real-72h.png'), fullPage: true });
  }, { headless: true, viewport: { width: 1600, height: 1000 } });
} finally {
  await srv?.close();
}
