import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeStore, snapshotDir, sess, iso, min } from '../helpers/store.mjs';
import { PROMPT_SENTINEL as S } from '../helpers/sentinel.mjs';
import { createState } from '../../src/state.js';
import { createLive } from '../../src/live.js';
import { createApp } from '../../src/http/app.js';

test('a full app run changes nothing in the store or transcript root; every new file is under dataDir', async () => {
  const now = Date.now();
  const s = makeStore({
    sessions: { c: { ...sess({ id: 'c', backing: 'cb1' }) }, w: sess({ id: 'w', parent: 'c', project: 'p', conducted: true, at: iso(now - min(5)) }) },
    ledger: [{ ts: iso(now - min(4)), kind: 'spawn', sessionId: 'w', stage: 'plan' }],
    costs: [{ ts: now - min(3), duration_ms: 1000, sessionId: 'w' }],
    transcripts: { cb1: [{ type: 'user', timestamp: iso(now - min(2)), uuid: 'u', message: { content: [{ type: 'text', text: `[[cc:wake-callback]]Worker \`w\` finished.\n[[cc:wake-body]]${S}` }] } }] },
  });
  const pub = path.join(s.root, 'pub-fixture');
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'index.html'), '<title>x</title>');

  const watched = [s.storeDir, s.transcriptRoot, s.projectsRoot];
  const before = Object.assign({}, ...(await Promise.all(watched.map(snapshotDir))));
  const beforePub = await snapshotDir(pub);

  const state = createState(s.config);
  const live = createLive({ state, config: state.config, schedule: () => () => {} });
  await live.start();
  await state.refreshStores();
  const server = http.createServer(createApp({ state, live, publicDir: pub }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  await state.runBackfill();
  assert.equal(state.backfill.status().state, 'ready');
  await (await fetch(`${url}/api/gantt`)).json();

  const appended = s.files.ledger;
  s.appendLedger({ ts: iso(now - min(1)), kind: 'retire', sessionId: 'w', reason: 'x' });
  await live.poll();
  const p = await (await fetch(`${url}/api/gantt`)).json();
  assert.equal(p.sessions.w.endKind, 'retired');
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  live.stop();

  const after = Object.assign({}, ...(await Promise.all(watched.map(snapshotDir))));
  const changed = Object.keys(after).filter((k) => before[k] !== after[k]);
  assert.deepEqual(changed, [appended]);
  assert.deepEqual(await snapshotDir(pub), beforePub);
  const files = Object.keys(await snapshotDir(s.dataDir));
  assert.ok(files.some((f) => f.endsWith('backfill-v1.json')));
  assert.ok(files.every((f) => f.startsWith(s.dataDir + path.sep)));
  s.cleanup();
});
