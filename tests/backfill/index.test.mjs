import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeStore, sess } from '../helpers/store.mjs';
import { PROMPT_SENTINEL as S } from '../helpers/sentinel.mjs';
import { BackfillIndex } from '../../src/backfill/index.js';
import { createDataDir } from '../../src/dataDir.js';

const TS = '2026-11-01T10:00:00.000Z';
const call = (id, target, tool = 'send_prompt') => ({
  type: 'assistant', timestamp: TS, uuid: 'a-' + id,
  message: { content: [{ type: 'tool_use', id, name: `mcp__code-conductor__${tool}`, input: { sessionId: target, text: S } }] },
});
const result = (id, ok = true) => ({
  type: 'user', timestamp: TS, uuid: 'r-' + id,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify({ ok, note: S }) }] }] },
});
const wake = (uuid, worker) => ({
  type: 'user', timestamp: TS, uuid, message: { content: [{ type: 'text', text: `[[cc:wake-callback]]Worker \`${worker}\` finished.\n[[cc:wake-body]]${S}` }] },
});

function setup(transcripts, extraSessions = {}) {
  const sessions = {
    cond: { ...sess({ id: 'cond' }), segments: [
      { id: 'cb1', reason: 'initial', at: TS }, { id: 'cb2', reason: 'renew', at: TS },
    ], current: 'cb2' },
    aaaa1111: sess({ id: 'aaaa1111', parent: 'cond', project: 'p', conducted: true }),
    stranger: { ...sess({ id: 'stranger' }), segments: [{ id: 'sb1', reason: 'initial', at: TS }] },
    ...extraSessions,
  };
  const s = makeStore({ sessions, transcripts });
  const byId = new Map(Object.entries(sessions).map(([id, r]) => [id, { id, ...r }]));
  const dd = createDataDir(s.dataDir);
  dd.ensure();
  const mkIndex = () => new BackfillIndex({ transcriptRoot: s.transcriptRoot, dataDir: dd });
  return { s, byId, dd, mkIndex };
}

test('only owners’ transcripts are scanned; non-owner calls absent from results and cache', async () => {
  const { s, byId, dd, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a')], sb1: [call('toolu_z', 'aaaa1111'), result('toolu_z')] });
  const idx = mkIndex();
  await idx.scan(byId);
  assert.deepEqual(idx.collect().calls.map((c) => c.id), ['toolu_a']);
  assert.equal(JSON.stringify(dd.readJson('backfill-v1.json')).includes('toolu_z'), false);
  s.cleanup();
});

test('all of an owner’s renew segments are scanned and each call carries its owner', async () => {
  const { s, byId, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a')], cb2: [call('toolu_b', 'aaaa1111'), result('toolu_b'), wake('u1', 'aaaa1111')] });
  const idx = mkIndex();
  await idx.scan(byId);
  const c = idx.collect();
  assert.deepEqual(c.calls.map((x) => [x.id, x.owner]).sort(), [['toolu_a', 'cond'], ['toolu_b', 'cond']]);
  assert.deepEqual(c.wakes.map((x) => [x.worker, x.owner]), [['aaaa1111', 'cond']]);
  s.cleanup();
});

test('a prune-overlap duplicate call (and wake) is counted once', async () => {
  const lines = [call('toolu_a', 'aaaa1111'), result('toolu_a'), wake('u1', 'aaaa1111')];
  const { s, byId, mkIndex } = setup({ cb1: lines, cb2: lines });
  const idx = mkIndex();
  await idx.scan(byId);
  const c = idx.collect();
  assert.equal(c.calls.length, 1);
  assert.equal(c.wakes.length, 1);
  s.cleanup();
});

test('incremental: a second pass reads only appended bytes (poison proves no re-read)', async () => {
  const { s, byId, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a')] });
  const idx = mkIndex();
  await idx.scan(byId);
  const p = s.transcriptPath('cb1');
  const orig = fs.readFileSync(p, 'utf8');
  // same-length poison over the already-read bytes
  fs.writeFileSync(p, orig.replaceAll('toolu_a', 'toolu_X'));
  s.append(p, call('toolu_c', 'aaaa1111'));
  s.append(p, result('toolu_c'));
  await idx.scan(byId);
  assert.deepEqual(idx.collect().calls.map((c) => c.id).sort(), ['toolu_a', 'toolu_c']);
  s.cleanup();
});

test('a fresh BackfillIndex loads the cache and does not rescan (poison)', async () => {
  const { s, byId, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a')] });
  await mkIndex().scan(byId);
  const p = s.transcriptPath('cb1');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('toolu_a', 'toolu_X'));
  const fresh = mkIndex();
  await fresh.scan(byId);
  assert.deepEqual(fresh.collect().calls.map((c) => c.id), ['toolu_a']);
  s.cleanup();
});

test('a cache version mismatch triggers a rebuild', async () => {
  const { s, byId, dd, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a')] });
  await mkIndex().scan(byId);
  const doc = dd.readJson('backfill-v1.json');
  doc.version = 999;
  doc.files = Object.fromEntries(Object.entries(doc.files).map(([k, v]) => [k, { ...v, calls: [], offset: v.size }]));
  dd.writeJsonAtomic('backfill-v1.json', doc);
  const fresh = mkIndex();
  await fresh.scan(byId);
  assert.deepEqual(fresh.collect().calls.map((c) => c.id), ['toolu_a']);
  s.cleanup();
});

test('a tool_use in pass 1 and its result in pass 2 → resolved (pending calls are not emitted)', async () => {
  const { s, byId, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111')] });
  const idx = mkIndex();
  await idx.scan(byId);
  assert.deepEqual(idx.collect().calls, []);
  s.append(s.transcriptPath('cb1'), result('toolu_a'));
  await idx.scan(byId);
  assert.deepEqual(idx.collect().calls.map((c) => [c.id, c.ok]), [['toolu_a', true]]);
  s.cleanup();
});

test('a refused call resolves to ok:false', async () => {
  const { s, byId, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a', false)] });
  const idx = mkIndex();
  await idx.scan(byId);
  assert.deepEqual(idx.collect().calls.map((c) => c.ok), [false]);
  s.cleanup();
});

test('a truncated file is rescanned from the start', async () => {
  const { s, byId, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a'), call('toolu_b', 'aaaa1111'), result('toolu_b')] });
  const idx = mkIndex();
  await idx.scan(byId);
  s.writeTranscript('cb1', [call('toolu_n', 'aaaa1111'), result('toolu_n')]);
  await idx.scan(byId);
  assert.deepEqual(idx.collect().calls.map((c) => c.id), ['toolu_n']);
  s.cleanup();
});

test('a missing transcript is counted and does not throw; progress reaches ready', async () => {
  const { s, byId, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a')] });
  const idx = mkIndex();
  await idx.scan(byId);
  const st = idx.status();
  assert.equal(st.state, 'ready');
  assert.equal(st.missing, 1);
  assert.equal(st.filesDone, st.filesTotal);
  s.cleanup();
});

test('the cache file text contains no prompt sentinel', async () => {
  const { s, byId, dd, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a'), wake('u1', 'aaaa1111')], cb2: [call('toolu_p', 'aaaa1111')] });
  await mkIndex().scan(byId);
  const text = fs.readFileSync(path.join(dd.dir, 'backfill-v1.json'), 'utf8');
  assert.ok(text.includes('toolu_a'));
  assert.equal(text.includes(S), false);
  s.cleanup();
});

test('C4: a scan requested mid-pass with a newer sessions snapshot is followed up, picking up the new owner', async () => {
  const sessions = {
    cond: { ...sess({ id: 'cond' }), segments: [{ id: 'cb1', reason: 'initial', at: TS }] },
    aaaa1111: sess({ id: 'aaaa1111', parent: 'cond', project: 'p', conducted: true }),
    lead: { ...sess({ id: 'lead', parent: 'cond', project: 'p', conducted: true }), segments: [{ id: 'lb1', reason: 'initial', at: TS }] },
    kid: sess({ id: 'kid', parent: 'lead', project: 'p', conducted: true }),
  };
  const s = makeStore({ sessions, transcripts: { cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a')], lb1: [call('toolu_n', 'kid'), result('toolu_n')] } });
  const all = new Map(Object.entries(sessions).map(([id, r]) => [id, { id, ...r }]));
  const early = new Map([...all].filter(([id]) => id !== 'kid')); // `lead` is not an owner yet
  const dd = createDataDir(s.dataDir);
  dd.ensure();
  const idx = new BackfillIndex({ transcriptRoot: s.transcriptRoot, dataDir: dd });
  let fired = false;
  const first = idx.scan(early, { onProgress: () => { if (!fired) { fired = true; idx.scan(all); idx.scan(all); } } });
  await first;
  assert.deepEqual(idx.collect().calls.map((c) => c.id).sort(), ['toolu_a', 'toolu_n']);
  assert.equal(idx.status().state, 'ready');
  s.cleanup();
});

test('S2: a malformed cache is rejected and rebuilt, not trusted', async () => {
  const bad = [
    { version: 1, files: { x: { size: 'big', offset: 0, owner: 'cond', pending: {}, calls: [], wakes: [] } } },
    { version: 1, files: { x: { size: 1, offset: 1, owner: 'cond', pending: {}, calls: 'nope', wakes: [] } } },
    { version: 1, files: { x: { size: 1, offset: 1, owner: 'cond', pending: [], calls: [], wakes: [] } } },
    { version: 1, files: { x: { size: 1, offset: 1, owner: 'cond', pending: {}, calls: [{ id: 1 }], wakes: [] } } },
    { version: 1, files: [] },
    { version: 1, files: { x: null } },
  ];
  for (const doc of bad) {
    const { s, byId, dd, mkIndex } = setup({ cb1: [call('toolu_a', 'aaaa1111'), result('toolu_a')] });
    dd.writeJsonAtomic('backfill-v1.json', doc);
    const idx = mkIndex();
    await idx.scan(byId);
    assert.deepEqual(idx.collect().calls.map((c) => c.id), ['toolu_a'], JSON.stringify(doc));
    s.cleanup();
  }
});

test('S4: a crafted wake line without a body marker leaves no sentinel in the cache', async () => {
  const crafted = { type: 'user', timestamp: TS, uuid: 'x', message: { content: [{ type: 'text', text: `[[cc:wake-callback]]Worker \`${S}\` finished` }] } };
  const { s, byId, dd, mkIndex } = setup({ cb1: [crafted, call('toolu_a', 'aaaa1111'), result('toolu_a')] });
  await mkIndex().scan(byId);
  assert.equal(fs.readFileSync(path.join(dd.dir, 'backfill-v1.json'), 'utf8').includes(S), false);
  s.cleanup();
});

test('S7: the backing index is rebuilt at most once per pass however many segments are missing', async () => {
  const many = { cond: { ...sess({ id: 'cond' }), segments: Array.from({ length: 6 }, (_, i) => ({ id: `ghost${i}`, reason: i ? 'renew' : 'initial', at: TS })) },
    aaaa1111: sess({ id: 'aaaa1111', parent: 'cond', project: 'p', conducted: true }) };
  const s = makeStore({ sessions: many });
  const byId = new Map(Object.entries(many).map(([id, r]) => [id, { id, ...r }]));
  const dd = createDataDir(s.dataDir);
  dd.ensure();
  let builds = 0;
  const idx = new BackfillIndex({ transcriptRoot: s.transcriptRoot, dataDir: dd, buildIndex: async (root) => { builds++; const { buildBackingIndex } = await import('../../src/backfill/locate.js'); return buildBackingIndex(root); } });
  await idx.scan(byId);
  assert.equal(idx.status().missing, 6);
  assert.ok(builds >= 1 && builds <= 2, `built ${builds} times`);
  s.cleanup();
});
