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
  links:[{ ts, type, from, to, heartbeat?, pair? }],
  diagnostics:{ liveness:'ok'|'unavailable',
                horizon:iso|null, unresolved, unmatchedStoreRows:{events}, unknownTools:{tool:n}, unknownKinds:{kind:n},
                otherVersionRows, corruptLines, treeLoops, missing:[file], errors:[string] } }
```

- `unresolved` counts link endpoints that match no session; `unmatchedStoreRows` counts event-log rows whose session is not in `sessions.json`.
- `pair:{sender,source}` is on both links of a forwarded call (the tool link, e.g. `send_prompt`, and its `forward` link). The window filter can drop one of them, and `source` may name a session absent from `sessions`.
- `horizon` is `EventLogReader.horizonTs` as ISO (rule below), or `null`; with `null` the payload has no projects, sessions or links.
- `window.from` is the requested `from` raised to the horizon. When the requested `to` is before the horizon (or there is no horizon) the payload has no projects, sessions or links and `window` is the requested one; `diagnostics.horizon` is still set when the log has one. For a request with `from <= to` the reported `window.from <= window.to` and no turn is inverted; a caller-supplied `from > to` is not validated and is echoed as given.
- `otherVersionRows` counts event-log rows whose `v` is not the one this plugin reads; they are skipped.
- Times are epoch ms. `end: null` means open-ended (frontend extends to `now`).
- `linkTypes` is the single catalog (`src/model/linkTypes.js`); the frontend reads it from the payload.
- Sessions overlapping the window are kept; turns and links are clipped to it. Nothing earlier than `window.from` is drawn: a bar spanning the horizon has `start` = horizon and only marks, rotations and stage bands from it on (the stage held at the horizon starts there).

## Store files read (read-only)

| File | Fields used |
|---|---|
| `sessions.json` (`{"sessions":{id:rec}}`, atomically written) | `segments[{id,reason,at,dropped?}]`, `current`, `title`, `parent`, `project`, `worktree`, `backend.model`, `turnEndSeq` |
| `events.jsonl` (contract: cc `docs/event-log.md`) | `v`, `ts`, `kind`, `actor.{type,sessionId}`, `subject`; `call`: `tool`, `outcome`, `forward`, `move.{from,to}`, `bind.{playbook,stage}`; `session`: `event`, `cause`; `turn`: `event`; `wake`: `recipient`, `heartbeat` |

Event-log rules (`EventLogReader`, `src/store/events.js`):

- Rows are read in line order; `ts` is informational. Fields outside the table above are never copied; a field of the wrong type is dropped.
- `call`, `session`, `turn` and `wake` rows are used; `config` rows are read and unused. Another `v` is skipped and counted in `diagnostics.otherVersionRows`; an unknown `kind` is skipped and counted in `diagnostics.unknownKinds`; a non-object or malformed line is skipped.
- Horizon (`EventLogReader.horizonTs`): the later of the `ts` of the first `wake` row or first `call` row with `actor.sessionId` (whichever comes first in line order) and the `ts` of the first `turn` row; `null` while either is missing. Only rows with a finite `ts` count.

Ids may be public ids, backing (segment) ids, or prefixes; see [architecture.md](architecture.md#id-resolution).
