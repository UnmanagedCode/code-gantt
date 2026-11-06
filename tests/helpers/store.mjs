import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const line = (v) => (typeof v === 'string' ? v : JSON.stringify(v)) + '\n';

/**
 * Builds a fresh synthetic cc store + transcript root + plugin data dir under a temp root.
 * Nothing here reads process.env.
 */
export function makeStore({ sessions = {}, ledger = [], costs = [], transcripts = {}, tag = 'proj' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-gantt-test-'));
  const projectsRoot = path.join(root, 'root');
  const storeDir = path.join(projectsRoot, '.code-conductor');
  const transcriptRoot = path.join(root, 'transcripts');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(path.join(transcriptRoot, tag), { recursive: true });

  const files = {
    sessions: path.join(storeDir, 'sessions.json'),
    ledger: path.join(storeDir, 'playbook-ledger.jsonl'),
    costs: path.join(storeDir, 'costs.jsonl'),
  };
  const api = {
    root, projectsRoot, storeDir, transcriptRoot, dataDir, files,
    config: { projectsRoot, storeDir, transcriptRoot, dataDir, conductorUrl: '' },
    writeSessions(obj) { fs.writeFileSync(files.sessions, JSON.stringify({ sessions: obj })); },
    transcriptPath(backingId) { return path.join(transcriptRoot, tag, backingId + '.jsonl'); },
    writeTranscript(backingId, lines) {
      const p = api.transcriptPath(backingId);
      fs.writeFileSync(p, lines.map(line).join(''));
      return p;
    },
    appendLedger(...evs) { fs.appendFileSync(files.ledger, evs.map(line).join('')); },
    appendCosts(...rows) { fs.appendFileSync(files.costs, rows.map(line).join('')); },
    append(file, text) { fs.appendFileSync(file, typeof text === 'string' ? text : line(text)); },
    appendTorn(file, partial) { fs.appendFileSync(file, partial); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  api.writeSessions(sessions);
  fs.writeFileSync(files.ledger, ledger.map(line).join(''));
  fs.writeFileSync(files.costs, costs.map(line).join(''));
  for (const [id, lines] of Object.entries(transcripts)) api.writeTranscript(id, lines);
  return api;
}

/** Recursive snapshot {relpath: "size:sha1"} used by the read-only test. */
export async function snapshotDir(dir) {
  const { createHash } = await import('node:crypto');
  const out = {};
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = fs.statSync(p).size + ':' + createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

// ---- small record builders shared by tests ----
export const iso = (ms) => new Date(ms).toISOString();
export const T0 = Date.parse('2026-11-01T00:00:00.000Z');
export const min = (n) => n * 60_000;

export function sess(over = {}) {
  const id = over.id;
  const at = over.at ?? iso(T0);
  const rec = {
    current: over.backing ?? id + '-0000-4000-8000-000000000000',
    segments: over.segments ?? [{ id: over.backing ?? id + '-0000-4000-8000-000000000000', reason: 'initial', at }],
  };
  for (const k of ['title', 'parent', 'project', 'worktree', 'conducted', 'turnEndSeq', 'mode']) if (over[k] !== undefined) rec[k] = over[k];
  return rec;
}
