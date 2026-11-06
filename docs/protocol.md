# Protocol

All URLs are relative to the plugin root (cc proxies it under a path prefix). Every response, including 404/500/SSE, carries `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`.

## Endpoints

| Method + path | Response |
|---|---|
| `GET /api/health` | `{"ok":true}` |
| `GET /api/gantt?from=<ms>&to=<ms>` | Payload below. Default window: last 72 h. Non-numeric `from`/`to` → 400. |
| `GET /api/stream` | SSE; `data: {"version":n}` on connect and whenever the state version changes. At most 32 concurrent clients; more get 503. `HEAD` returns the headers and ends. |
| `GET /`, `/index.html`, `/app.js`, `/main.js`, `/style.css`, `/lib/*.js`, `/render/*.js` | Static allowlist built from `public/`; everything else 404 (no SPA fallback). |
| other methods | 405 |

## Payload

```
{ now, window:{from,to}, version, linkTypes:[…],
  projects:[{ project, trees:[{ rootId, rows:[{id, depth, context}] }] }],
  sessions:{ [id]:{ id, title?, project?, worktree?, model?, playbook?, parent?, orphan?,
                    start, end|null, endKind:'retired'|'killed'|'live'|'approx', endReason?,
                    turns:[[s,e]…], turnCount, rotations:[{at,reason}],
                    stages:[{stage,from,to|null,via?}], marks:[{at,kind:'retire'|'resume'}] } },
  links:[{ ts, type, from, to, source:'ledger'|'backfill', heartbeat? }],
  diagnostics:{ liveness:'ok'|'unavailable',
                backfill:{state:'scanning'|'ready', filesDone, filesTotal, missing, corrupt},
                cutoff:iso|null, unresolved, unmatchedStoreRows:{ledger,costs}, unknownTools:{tool:n}, unknownKinds:{kind:n},
                corruptLines, treeLoops, missing:[file], errors:[string] } }
```

- `unresolved` counts link endpoints (ledger or transcript) that match no session; `unmatchedStoreRows` counts ledger events and cost rows whose session is not in `sessions.json`.
- Times are epoch ms. `end: null` means open-ended (frontend extends to `now`).
- `source: 'ledger'` marks every link derived from the cc store (sessions.json spawn edges and ledger events); `'backfill'` marks transcript-derived links.
- `linkTypes` is the single catalog (`src/model/linkTypes.js`); the frontend reads it from the payload.
- Sessions overlapping the window are kept; turns and links are clipped to it.

## Store files read (read-only)

| File | Fields used |
|---|---|
| `sessions.json` (`{"sessions":{id:rec}}`, atomically written) | `segments[{id,reason,at,dropped?}]`, `current`, `title`, `parent`, `project`, `worktree`, `backend.model`, `turnEndSeq` |
| `playbook-ledger.jsonl` | `ts`, `kind`, `sessionId`, `conductorSessionId`, `forwardSessionId`, `tool`, `from`, `to`, `via`, `stage`, `playbook`, `reason`, `heartbeat` |
| `costs.jsonl` | `ts` (epoch ms, turn end), `duration_ms`, `sessionId` |
| `<transcript root>/<dir>/<backing id>.jsonl` | conductor lines, see below |

Ledger kinds: `spawn`, `transition`, `retire`, `resume`, `interaction`, `wake` are used; `refusal` and `enforcement` are ignored; others are skipped and counted in `diagnostics.unknownKinds`. A `tool` carrying the `mcp__code-conductor__` prefix is stripped.

Ledger event shapes accepted for interactions and wakes:

| Kind | Fields |
|---|---|
| `interaction` | `conductorSessionId`, `sessionId`, `tool`, optional `forwardSessionId` |
| `wake` | `conductorSessionId`, `sessionId` (worker), optional `heartbeat: true` |

Ids in any source may be public ids, backing (segment) ids, or prefixes; see [architecture.md](architecture.md#id-resolution).

## Transcript lines recognised by the backfill

| Line | Yields |
|---|---|
| assistant `tool_use` named `mcp__code-conductor__<governed tool>` with `input.sessionId` | call (tool, target, optional `input.forward.sessionId`) |
| user `tool_result` for a pending call | result: `ok:false` on `is_error` or JSON `ok:false` |
| user line or `attachment` of type `queued_command` containing `[[cc:wake-callback]]Worker \`ID\` …` | wake. The header is the first line after the marker (cut at `[[cc:wake-body]]` or the next marker, at most 600 chars); `ID` must be 8-hex (optionally `-xxxx`) or a UUID; `did NOT finish` marks a heartbeat. At most 50 markers per line are considered. |

Only ids, tool, ts, heartbeat and ok are kept. A `tool_use` id must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`.

## Backfill cache

`<CONDUCTOR_PLUGIN_DATA_DIR>/backfill-v1.json`:

```
{ version: 1,
  files: { "<abs path>": { size, offset, owner, pending:{ "<toolu id>":{ts,tool,target,forward?} },
                           calls:[{id,ts,tool,target,forward?,ok}], wakes:[{key,ts,worker,heartbeat?}] } } }
```

The file is untrusted input: a version mismatch, unreadable file, or any entry of the wrong shape (non-numeric `size`/`offset`, non-array `calls`/`wakes`, non-object `pending`, ill-typed call or wake) rejects the whole cache and the backfill rebuilds. A cached `tool` outside the governed set renders as `other`.
