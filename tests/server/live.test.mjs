import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, sess, iso, T0, min } from '../helpers/store.mjs';
import { createState } from '../../src/state.js';
import { createLive } from '../../src/live.js';

const POLL_MS = 5000;

function rig({ conductorUrl = 'http://cc.test', rows = [], fetchFails = false } = {}) {
  const s = makeStore({
    sessions: { c: sess({ id: 'c' }), w: sess({ id: 'w', parent: 'c', project: 'p', conducted: true }) },
    ledger: [{ ts: iso(T0), kind: 'spawn', sessionId: 'w', stage: 'plan' }],
  });
  const state = createState({ ...s.config, conductorUrl });
  const timers = [];
  const schedule = (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
  const fire = (ms) => { const t = timers.filter((x) => !x.cancelled && x.ms === ms).pop(); assert.ok(t, `no timer for ${ms}`); t.cancelled = true; return t.fn(); };
  const sockets = [];
  const connect = (url, h) => { const sock = { url, h, closed: false, close() { this.closed = true; } }; sockets.push(sock); return sock; };
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    if (fetchFails) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => rows };
  };
  const live = createLive({ state, config: state.config, fetch: fetchImpl, connect, schedule });
  const changes = [];
  live.events.on('changed', (v) => changes.push(v));
  return { s, state, live, timers, fire, sockets, fetchCalls, changes };
}

test('an instances hint re-fetches liveness and emits changed once (debounced)', async () => {
  const r = rig({ rows: [{ sessionId: 'w', status: 'running' }, { sessionId: 'x', status: 'exited' }, { sessionId: 'y', status: 'crashed' }] });
  await r.live.start();
  await r.state.refreshStores();
  assert.equal(r.sockets[0].url, 'ws://cc.test/ws');
  const before = r.fetchCalls.length;
  const base = r.changes.length;
  for (let i = 0; i < 3; i++) r.sockets[0].h.onMessage(JSON.stringify({ t: 'instances' }));
  r.sockets[0].h.onMessage(JSON.stringify({ t: 'other' }));
  await r.fire(500);
  assert.equal(r.fetchCalls.length, before + 1);
  assert.equal(r.fetchCalls.at(-1), 'http://cc.test/api/instances');
  assert.equal(r.changes.length, base + 1);
  assert.deepEqual([...r.state.liveSet], ['w']);
  r.live.stop(); r.s.cleanup();
});

test('a ledger append detected by poll emits changed; an unchanged poll does not', async () => {
  const r = rig({ conductorUrl: '' });
  await r.live.start();
  await r.state.refreshStores();
  const base = r.changes.length;
  await r.live.poll();
  assert.equal(r.changes.length, base);
  r.s.appendLedger({ ts: iso(T0 + min(1)), kind: 'retire', sessionId: 'w', reason: 'x' });
  await r.live.poll();
  assert.equal(r.changes.length, base + 1);
  assert.equal(r.state.ledger.events.at(-1).kind, 'retire');
  r.live.stop(); r.s.cleanup();
});

test('a ws close schedules a reconnect with capped exponential backoff, reset on open', async () => {
  const r = rig();
  await r.live.start();
  const delays = [];
  for (let i = 0; i < 7; i++) {
    r.sockets.at(-1).h.onClose();
    const t = r.timers.filter((x) => !x.cancelled && x.ms !== POLL_MS).pop();
    delays.push(t.ms);
    await r.fire(t.ms);
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
  r.sockets.at(-1).h.onOpen();
  r.sockets.at(-1).h.onClose();
  assert.equal(r.timers.filter((x) => !x.cancelled && x.ms !== POLL_MS).pop().ms, 500);
  r.live.stop(); r.s.cleanup();
});

test('without a conductorUrl liveness is unavailable and nothing connects or fetches', async () => {
  const r = rig({ conductorUrl: '' });
  await r.live.start();
  assert.equal(r.state.liveSet, null);
  assert.equal(r.sockets.length, 0);
  assert.equal(r.fetchCalls.length, 0);
  r.live.stop(); r.s.cleanup();
});

test('an unreachable instances endpoint leaves liveness unavailable', async () => {
  const r = rig({ fetchFails: true });
  await r.live.start();
  assert.equal(r.state.liveSet, null);
  r.live.stop(); r.s.cleanup();
});
