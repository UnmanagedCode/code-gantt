import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('server.js exits non-zero with a clear message when PROJECTS_ROOT is unset', () => {
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../server.js')], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PROJECTS_ROOT/);
});

import { spawn } from 'node:child_process';
import net from 'node:net';
import { makeStore, sess } from '../helpers/store.mjs';

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function bootServer(conductorUrl) {
  const s = makeStore({ sessions: { cccc0000: sess({ id: 'cccc0000' }), aaaa1111: sess({ id: 'aaaa1111', parent: 'cccc0000', project: 'p', conducted: true }) } });
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../server.js')], {
    env: { PATH: process.env.PATH, PORT: String(port), PROJECTS_ROOT: s.projectsRoot, CONDUCTOR_URL: conductorUrl },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 2000; // far below the liveness fetch timeout
  let health = null;
  while (Date.now() < deadline && !health) {
    if (child.exitCode != null) break;
    try { const r = await fetch(`${url}/api/health`); if (r.ok) health = await r.json(); } catch { await new Promise((r) => setTimeout(r, 25)); }
  }
  const gantt = health ? await (await fetch(`${url}/api/gantt`)).json() : null;
  child.kill('SIGTERM');
  const result = { health, gantt, exitCode: child.exitCode };
  s.cleanup();
  return result;
}

test('S1: a malformed CONDUCTOR_URL does not crash the server; it serves with liveness unavailable', async () => {
  for (const url of ['not a url', 'ftp://x']) {
    const r = await bootServer(url);
    assert.deepEqual(r.health, { ok: true }, url);
    assert.equal(r.gantt.diagnostics.liveness, 'unavailable');
  }
});

test('S1: a black-holed conductor does not delay listening or /api/health', async () => {
  const hole = net.createServer(() => {}); // accepts, never answers
  await new Promise((r) => hole.listen(0, '127.0.0.1', r));
  const r = await bootServer(`http://127.0.0.1:${hole.address().port}`);
  hole.close();
  assert.deepEqual(r.health, { ok: true });
  assert.equal(r.gantt.diagnostics.liveness, 'unavailable');
});
