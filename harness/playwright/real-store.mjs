// Renders the REAL cc store, read-only by construction:
//  - safety tests must pass first (source scan + before/after snapshot test),
//  - the plugin's only write location is a fresh temp data dir outside PROJECTS_ROOT and the transcript root,
//  - the temp dir is deleted afterwards.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';
import { resolveConfig } from '../../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });

// 1. preconditions
const safety = spawnSync('node', ['--test', '--test-concurrency=1', 'tests/safety/*.test.mjs'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !['PROJECTS_ROOT', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_ROOT', 'CONDUCTOR_URL', 'CONDUCTOR_PLUGIN_DATA_DIR'].includes(k))),
});
if (safety.status !== 0) throw new Error('safety tests failed: refusing to boot against the real store');

const projectsRoot = process.env.CC_PROJECTS_ROOT;
if (!projectsRoot) throw new Error('CC_PROJECTS_ROOT is not set');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-gantt-real-'));
const config = resolveConfig({ ...process.env, PROJECTS_ROOT: projectsRoot, CONDUCTOR_PLUGIN_DATA_DIR: dataDir });
const inside = (child, parent) => { const r = path.relative(fs.realpathSync(parent), fs.realpathSync(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
for (const protectedDir of [projectsRoot, config.transcriptRoot]) {
  if (fs.existsSync(protectedDir) && inside(dataDir, protectedDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`data dir ${dataDir} resolves inside ${protectedDir}: aborting`);
  }
}

const { bootServer, withPage } = await import(BROWSER);
const SESSION_KEYS = new Set(['id', 'title', 'project', 'worktree', 'model', 'playbook', 'parent', 'orphan', 'start', 'end', 'endKind', 'endReason', 'turns', 'turnCount', 'rotations', 'stages', 'marks']);
const LINK_KEYS = new Set(['ts', 'type', 'from', 'to', 'source', 'heartbeat']);

let srv;
try {
  srv = await bootServer({
    cwd: repoRoot,
    entry: 'server.js',
    env: { PROJECTS_ROOT: projectsRoot, CONDUCTOR_PLUGIN_DATA_DIR: dataDir },
  });
  // 2/3. wait for the first backfill scan
  const t0 = Date.now();
  const get = async (q) => (await fetch(`${srv.url}/api/gantt${q}`)).json();
  let payload;
  for (;;) {
    payload = await get('');
    const b = payload.diagnostics.backfill;
    console.log(`backfill ${b.state} ${b.filesDone}/${b.filesTotal} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (b.state === 'ready') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`first scan: ${elapsed}s; missing transcripts: ${payload.diagnostics.backfill.missing}`);

  const wide = await get(`?from=${Date.now() - 30 * 86400_000}&to=${Date.now()}`);
  assert.ok(wide.projects.length >= 1, 'at least one project group');
  assert.ok(Object.values(wide.sessions).some((s) => s.stages.length), 'at least one stage band');
  assert.ok(wide.links.some((l) => l.source === 'backfill'), 'at least one backfilled link');
  for (const p of [payload, wide]) {
    for (const s of Object.values(p.sessions)) assert.deepEqual(Object.keys(s).filter((k) => !SESSION_KEYS.has(k)), [], 'session keys');
    for (const l of p.links) assert.deepEqual(Object.keys(l).filter((k) => !LINK_KEYS.has(k)), [], 'link keys');
  }
  console.log(`30d window: ${wide.projects.length} projects, ${Object.keys(wide.sessions).length} sessions, ${wide.links.length} links; diagnostics ${JSON.stringify(wide.diagnostics)}`);

  await withPage(async (page) => {
    await page.goto(srv.url);
    await page.waitForSelector('svg.chart');
    await page.screenshot({ path: path.join(shots, 'real-72h.png'), fullPage: true });
    const axis72 = await page.$eval('.axis', (n) => n.textContent);
    await page.selectOption('select[name="range"]', String(14 * 86400_000));
    await page.waitForFunction((a) => document.querySelector('.axis')?.textContent !== a, axis72, { timeout: 60_000 });
    await page.screenshot({ path: path.join(shots, 'real-14d.png'), fullPage: true });
  }, { headless: true, viewport: { width: 1600, height: 1000 } });
} finally {
  await srv?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`temp data dir removed: ${!fs.existsSync(dataDir)}`);
}
