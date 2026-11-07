import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, sess, iso, T0, min, evCall, evSession, SYSTEM } from '../helpers/store.mjs';
import { createState } from '../../src/state.js';
import { createLive } from '../../src/live.js';

const POLL_MS = 5000;

function rig({ conductorUrl = 'http://cc.test', rows = [], fetchFails = false, connectThrows = false, fetchImpl: customFetch, timeoutMs } = {}) {
  const s = makeStore({
    sessions: { c: sess({ id: 'c' }), w: sess({ id: 'w', parent: 'c', project: 'p', conducted: true }) },
    events: [evCall(iso(T0), { type: 'conductor' }, 'w', 'spawn_instance', { bind: { playbook: 'classic', stage: 'plan' } })],
  });
  const state = createState({ ...s.config, conductorUrl });
  const timers = [];
  const schedule = (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
  const fire = (ms) => { const t = timers.filter((x) => !x.cancelled && x.ms === ms).pop(); assert.ok(t, `no timer for ${ms}`); t.cancelled = true; return t.fn(); };
  const sockets = [];
  const connect = (url, h) => {
    if (connectThrows) throw new Error('bad ws url'); const sock = { url, h, closed: false, close() { this.closed = true; } }; sockets.push(sock); return sock; };
  const fetchCalls = [];
  const fetchOpts = [];
  const fetchImpl = customFetch ?? (async (url, opts) => {
    fetchCalls.push(url);
    fetchOpts.push(opts);
    if (fetchFails) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => rows };
  });
  const live = createLive({ state, config: state.config, fetch: fetchImpl, connect, schedule, livenessTimeoutMs: timeoutMs });
  const changes = [];
  live.events.on('changed', (v) => changes.push(v));
  return { s, state, live, timers, fire, sockets, fetchCalls, fetchOpts, changes };
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

test('an event-log append detected by poll emits changed; an unchanged poll does not', async () => {
  const r = rig({ conductorUrl: '' });
  await r.live.start();
  await r.state.refreshStores();
  const base = r.changes.length;
  await r.live.poll();
  assert.equal(r.changes.length, base);
  r.s.appendEvents(evSession(iso(T0 + min(1)), SYSTEM, 'w', 'exit'));
  await r.live.poll();
  assert.equal(r.changes.length, base + 1);
  assert.equal(r.state.events.events.at(-1).event, 'exit');
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

test('C5: a poll issued while another is in flight waits for it and sees the data; no duplicates result', async () => {
  const r = rig({ conductorUrl: '' });
  await r.live.start();
  await r.state.refreshStores();
  const base = r.state.events.events.length;
  r.s.appendEvents(evSession(iso(T0 + min(2)), SYSTEM, 'w', 'exit'));
  const p1 = r.live.poll();
  const p2 = r.live.poll();
  await p2;
  assert.equal(r.state.events.events.length, base + 1);
  await p1;
  await Promise.all([r.state.refreshStores(), r.state.refreshStores()]);
  assert.equal(r.state.events.events.length, base + 1);
  r.live.stop(); r.s.cleanup();
});

test('C5: a change landing during a poll triggers a follow-up poll, not a lost update', async () => {
  const r = rig({ conductorUrl: '' });
  await r.live.start();
  await r.state.refreshStores();
  const base = r.state.events.events.length;
  r.s.appendEvents(evSession(iso(T0 + min(2)), SYSTEM, 'w', 'exit'));
  const p1 = r.live.poll();
  r.s.appendEvents(evSession(iso(T0 + min(3)), SYSTEM, 'w', 'resume'));
  await Promise.all([p1, r.live.poll()]);
  assert.equal(r.state.events.events.length, base + 2);
  r.live.stop(); r.s.cleanup();
});

test('S1: the liveness fetch carries an abort signal and a hung conductor degrades to unavailable', async () => {
  const hung = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('timed out'))));
  const r = rig({ fetchImpl: hung, timeoutMs: 20 });
  await r.live.start();
  assert.equal(r.state.liveSet, null);
  const ok = rig({ rows: [] });
  await ok.live.start();
  assert.ok(ok.fetchOpts[0].signal instanceof AbortSignal);
  for (const x of [r, ok]) { x.live.stop(); x.s.cleanup(); }
});

test('S1: a malformed or non-http(s) CONDUCTOR_URL is ignored: no throw, no connect, no fetch, unavailable', async () => {
  for (const url of ['not a url', 'ftp://cc.test', 'ws://cc.test', 'http://']) {
    const r = rig({ conductorUrl: url });
    await r.live.start();
    assert.equal(r.state.liveSet, null, url);
    assert.equal(r.sockets.length, 0, url);
    assert.equal(r.fetchCalls.length, 0, url);
    r.live.stop(); r.s.cleanup();
  }
});

test('S1: a throwing ws constructor schedules a reconnect with backoff instead of crashing, on every attempt', async () => {
  const r = rig({ connectThrows: true });
  await r.live.start();
  const retry = () => r.timers.filter((x) => !x.cancelled && x.ms !== POLL_MS).pop();
  assert.equal(retry().ms, 500);
  await r.fire(500);
  assert.equal(retry().ms, 1000);
  r.live.stop(); r.s.cleanup();
});
