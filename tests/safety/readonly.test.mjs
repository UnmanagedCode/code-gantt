import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeStore, snapshotDir, sess, iso, min, evCall, evSession, horizonRows, SYSTEM } from '../helpers/store.mjs';
import { createState } from '../../src/state.js';
import { createLive } from '../../src/live.js';
import { createApp } from '../../src/http/app.js';

// S2: the plugin has no write path, so a whole run - including an incremental re-read after the store
// changed - leaves every file under the temp root as it was.
test('a full app run writes nothing: the snapshot of the whole temp root is identical before and after', async () => {
  const now = Date.now();
  const s = makeStore({
    sessions: { cccc0000: sess({ id: 'cccc0000', backing: 'cb1' }), aaaa1111: sess({ id: 'aaaa1111', parent: 'cccc0000', project: 'p', conducted: true, at: iso(now - min(5)) }) },
    events: [
      evCall(iso(now - min(4)), { type: 'conductor' }, 'aaaa1111', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } }),
      ...horizonRows(now - min(3), 'aaaa1111', 'cccc0000'),
    ],
  });
  const pub = path.join(s.root, 'pub-fixture');
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'index.html'), '<title>x</title>');
  const state = createState(s.config);
  const live = createLive({ state, config: state.config, schedule: () => () => {} });
  const changed = [];
  live.events.on('changed', (v) => changed.push(v));
  await live.start();
  await state.refreshStores();
  // the store changes after the first read and before the snapshot: the poll must detect it and re-read incrementally
  s.appendEvents(evSession(now - min(1), SYSTEM, 'aaaa1111', 'exit', { cause: 'exited' }));
  const before = await snapshotDir(s.root);

  const server = http.createServer(createApp({ state, live, publicDir: pub }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${url}/api/gantt`)).json()).sessions.aaaa1111.endKind, 'approx', 'the appended row is not read yet');
  await live.poll();
  assert.equal(changed.length, 1, 'the poll refreshed');
  const p = await (await fetch(`${url}/api/gantt`)).json();
  assert.equal(p.sessions.aaaa1111.endKind, 'exited', 'the appended row was re-read');
  await fetch(`${url}/`);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  live.stop();

  assert.deepEqual(await snapshotDir(s.root), before);
  s.cleanup();
});
