import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeStore, sess, iso, T0, min } from '../helpers/store.mjs';
import { createState } from '../../src/state.js';
import { createLive } from '../../src/live.js';
import { createApp } from '../../src/http/app.js';

async function boot() {
  const s = makeStore({
    sessions: { c: sess({ id: 'c' }), w: sess({ id: 'w', parent: 'c', project: 'p', conducted: true, at: iso(Date.now() - min(5)) }) },
    ledger: [{ ts: iso(Date.now() - min(4)), kind: 'spawn', sessionId: 'w', stage: 'plan' }],
  });
  const pub = path.join(s.root, 'public');
  fs.mkdirSync(path.join(pub, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(pub, 'app.js'), 'export {};');
  fs.writeFileSync(path.join(pub, 'lib', 'x.js'), 'export {};');
  fs.writeFileSync(path.join(s.root, 'secret.txt'), 'nope');
  const state = createState(s.config);
  const live = createLive({ state, config: state.config, schedule: () => () => {} });
  await live.start();
  await state.refreshStores();
  const server = http.createServer(createApp({ state, live, publicDir: pub }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { s, state, live, server, port, url: `http://127.0.0.1:${port}`, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); live.stop(); s.cleanup(); } };
}
const rawGet = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
});

test('api/health → 200 {ok:true}; api/gantt → payload; bad window → 400', async () => {
  const b = await boot();
  assert.deepEqual(await (await fetch(`${b.url}/api/health`)).json(), { ok: true });
  const p = await (await fetch(`${b.url}/api/gantt`)).json();
  assert.ok(p.sessions.w);
  assert.ok(Array.isArray(p.linkTypes));
  assert.equal((await fetch(`${b.url}/api/gantt?from=abc`)).status, 400);
  await b.close();
});

test('every response (HTML, JS, API, 404, SSE) carries the CSP and nosniff', async () => {
  const b = await boot();
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
  const ctl = new AbortController();
  const responses = [
    await fetch(`${b.url}/`), await fetch(`${b.url}/app.js`), await fetch(`${b.url}/api/gantt`),
    await fetch(`${b.url}/nope`), await fetch(`${b.url}/api/stream`, { signal: ctl.signal }), await fetch(`${b.url}/api/gantt`, { method: 'POST' }),
  ];
  for (const r of responses) {
    assert.equal(r.headers.get('content-security-policy'), csp, r.url);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', r.url);
  }
  assert.equal(responses[3].status, 404);
  assert.equal(responses[5].status, 405);
  ctl.abort();
  await b.close();
});

test('static allowlist: index and scripts served; traversal, unknown paths and SPA fallback are 404', async () => {
  const b = await boot();
  assert.equal((await fetch(`${b.url}/index.html`)).status, 200);
  assert.equal((await fetch(`${b.url}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${b.url}/lib/x.js`)).status, 200);
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/lib/../../secret.txt', '/unknown', '/%00', '/lib/']) {
    assert.equal((await rawGet(b.port, p)).statusCode, 404, p);
  }
  await b.close();
});

test('api/stream emits the current version, then a new one after a ledger append and a poll', async () => {
  const b = await boot();
  const ctl = new AbortController();
  const res = await fetch(`${b.url}/api/stream`, { signal: ctl.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const nextVersion = async () => {
    for (;;) {
      const { value } = await reader.read();
      const m = /data: (\{.*\})/.exec(dec.decode(value));
      if (m) return JSON.parse(m[1]).version;
    }
  };
  const v0 = await nextVersion();
  b.s.appendLedger({ ts: iso(Date.now()), kind: 'retire', sessionId: 'w', reason: 'x' });
  await b.live.poll();
  const v1 = await nextVersion();
  assert.ok(v1 > v0);
  ctl.abort();
  await b.close();
});
