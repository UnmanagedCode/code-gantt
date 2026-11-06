# Protocol

All URLs are relative to the plugin root (cc proxies it under a path prefix). Every response, including 404/500/SSE, carries `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`.

## Endpoints

| Method + path | Response |
|---|---|
| `GET /api/health` | `{"ok":true}` |
| `GET /api/gantt?from=<ms>&to=<ms>` | Payload below. Default window: last 72 h. Non-numeric `from`/`to` → 400. |
| `GET /api/stream` | SSE; `data: {"version":n}` on connect and whenever the state version changes. |
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
                cutoff:iso|null, unresolved, unknownTools:{tool:n}, unknownKinds:{kind:n},
                corruptLines, treeLoops, missing:[file], errors:[string] } }
```

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
| user line or `attachment` of type `queued_command` containing `[[cc:wake-callback]]Worker \`ID\` …` | wake (worker id from the header before `[[cc:wake-body]]`; `did NOT finish` marks a heartbeat) |

Only ids, tool, ts, heartbeat and ok are kept.

## Backfill cache

`<CONDUCTOR_PLUGIN_DATA_DIR>/backfill-v1.json`:

```
{ version: 1,
  files: { "<abs path>": { size, offset, owner, pending:{ "<toolu id>":{ts,tool,target,forward?} },
                           calls:[{id,ts,tool,target,forward?,ok}], wakes:[{key,ts,worker,heartbeat?}] } } }
```

A version mismatch or unreadable file triggers a rebuild.
