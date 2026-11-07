// Renders the REAL cc store, read-only by construction:
//  - safety tests must pass first (source scan + before/after snapshot test),
//  - the plugin has no write path.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';

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
const LINK_KEYS = new Set(['ts', 'type', 'from', 'to', 'heartbeat']);

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
  assert.ok(wide.projects.length >= 1, 'at least one project group');
  assert.equal(wide.window.from, horizonMs, 'a window before the horizon is clamped to it');
  assert.ok(wide.links.every((l) => l.ts >= horizonMs), 'every link is at or after the horizon');
  for (const p of [payload, wide]) {
    for (const s of Object.values(p.sessions)) assert.deepEqual(Object.keys(s).filter((k) => !SESSION_KEYS.has(k)), [], 'session keys');
    for (const l of p.links) assert.deepEqual(Object.keys(l).filter((k) => !LINK_KEYS.has(k)), [], 'link keys');
  }
  console.log(`30d window: ${wide.projects.length} projects, ${Object.keys(wide.sessions).length} sessions, ${wide.links.length} links; diagnostics ${JSON.stringify(wide.diagnostics)}`);

  await withPage(async (page) => {
    await page.goto(srv.url);
    await page.waitForSelector('svg.chart');
    await page.screenshot({ path: path.join(shots, 'real-72h.png'), fullPage: true });
  }, { headless: true, viewport: { width: 1600, height: 1000 } });
} finally {
  await srv?.close();
}
