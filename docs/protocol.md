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
                    start, end|null, endKind:'exited'|'killed'|'live'|'approx', endReason?,
                    turns:[[s,e]…], turnCount, rotations:[{at,reason}],
                    stages:[{stage,from,to|null,via?}], marks:[{at,kind:'exit'|'resume'}] } },
  links:[{ ts, type, from, to, source:'store'|'backfill', heartbeat? }],
  diagnostics:{ liveness:'ok'|'unavailable',
                backfill:{state:'scanning'|'ready', filesDone, filesTotal, missing, corrupt, droppedMarkers},
                cutoff:iso|null, unresolved, unmatchedStoreRows:{events,costs}, unknownTools:{tool:n}, unknownKinds:{kind:n},
                otherVersionRows, corruptLines, treeLoops, missing:[file], errors:[string] } }
```

- `unresolved` counts link endpoints (event log or transcript) that match no session; `unmatchedStoreRows` counts event-log rows and cost rows whose session is not in `sessions.json`.
- `otherVersionRows` counts event-log rows whose `v` is not the one this plugin reads; they are skipped.
- Times are epoch ms. `end: null` means open-ended (frontend extends to `now`).
- `source: 'store'` marks every link derived from the cc store (sessions.json spawn edges and event-log rows); `'backfill'` marks transcript-derived links.
- `linkTypes` is the single catalog (`src/model/linkTypes.js`); the frontend reads it from the payload.
- Sessions overlapping the window are kept; turns and links are clipped to it.

## Store files read (read-only)

| File | Fields used |
|---|---|
| `sessions.json` (`{"sessions":{id:rec}}`, atomically written) | `segments[{id,reason,at,dropped?}]`, `current`, `title`, `parent`, `project`, `worktree`, `backend.model`, `turnEndSeq` |
| `events.jsonl` (contract: cc `docs/event-log.md`) | `v`, `ts`, `kind`, `actor.{type,sessionId}`, `subject`; `call`: `tool`, `outcome`, `forward`, `move.{from,to}`, `bind.{playbook,stage}`; `session`: `event`, `cause`; `turn`: `event`; `wake`: `recipient`, `heartbeat` |
| `costs.jsonl` | `ts` (epoch ms, turn end), `duration_ms`, `sessionId` |
| `<transcript root>/<dir>/<backing id>.jsonl` | conductor lines, see below |

Event-log rules (`EventLogReader`, `src/store/events.js`):

- Rows are read in line order; `ts` is informational. Fields outside the table above are never copied; a field of the wrong type is dropped.
- `call`, `session`, `turn` and `wake` rows are used; `config` rows are read and unused. Another `v` is skipped and counted in `diagnostics.otherVersionRows`; an unknown `kind` is skipped and counted in `diagnostics.unknownKinds`; a non-object or malformed line is skipped.
- `diagnostics.cutoff` is the `ts` of the first `wake` row or first `call` row with `actor.sessionId`; the transcript backfill applies before it.
- The first `turn` row's `ts` bounds `costs.jsonl` turns: a costs turn is used only if it ended before it.

Ids in any source may be public ids, backing (segment) ids, or prefixes; see [architecture.md](architecture.md#id-resolution).

## Transcript lines recognised by the backfill

| Line | Yields |
|---|---|
| assistant `tool_use` named `mcp__code-conductor__<governed tool>` with `input.sessionId` | call (tool, target, optional `input.forward.sessionId`) |
| user `tool_result` for a pending call | result: `ok:false` on `is_error` or JSON `ok:false`, plus the line's `ts` (kept as the call's `rts`) |
| user line or `attachment` of type `queued_command`, per text block that **starts with** `[[cc:wake-callback]]` | wake (one per such block; cc recognises a wake with `startsWith`, so a marker anywhere else — mid-line, in a quoted human prompt, in a folded body — is plain text and neither starts a delivery nor ends a header). Coalesced deliveries are separate blocks of one line. The header is the block text after the marker up to `\n[[cc:wake-body]]`, at most 8192 chars (cc's longest human-prompt note, decline note and stale note before the clause fit); nothing after the body separator is read. The worker is the first `Worker \`ID\`` clause on a header line that does not start with `>` (quoted human prompts never supply it); `ID` must be 8-hex (optionally `-xxxx`) or a UUID. The heartbeat flag is set when `did NOT finish` directly follows that clause. At most 500 deliveries per line are extracted and 2000 blocks considered; the overflow is counted in `diagnostics.backfill.droppedMarkers`. |

`ts` is the `tool_use` line (written before the handler runs); `rts` is the `tool_result` line (written after it, like the `call` row). Only ids, tool, ts, rts, heartbeat and ok are kept. A `tool_use` id must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`.

## Backfill cache

`<CONDUCTOR_PLUGIN_DATA_DIR>/backfill.json`:

```
{ version: 2,
  files: { "<abs path>": { size, offset, owner, pending:{ "<toolu id>":{ts,tool,target,forward?} },
                           calls:[{id,ts,rts?,tool,target,forward?,ok}], wakes:[{key,ts,worker,heartbeat?}] } } }
```

The file is untrusted input: a version mismatch (the earlier `backfill-v1.json`, which lacked `rts`, is deleted and never read), unreadable file, or any entry of the wrong shape (non-numeric `size`/`offset`, non-array `calls`/`wakes`, non-object `pending`, ill-typed call or wake) rejects the whole cache and the backfill rebuilds. A cached `tool` outside the governed set renders as `other`.
