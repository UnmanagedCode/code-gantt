# Architecture

## Module map

| Path | Responsibility |
|---|---|
| `server.js` | Thin: resolve config, build state, start `Live`, listen on `127.0.0.1:$PORT||7300`, start the backfill in the background. Exits non-zero if `CONDUCTOR_PLUGIN_DATA_DIR` is unset. |
| `src/config.js` | `resolveConfig(env)`: `projectsRoot`, `storeDir`, `transcriptRoot`, `dataDir`, `conductorUrl`. Library code never reads `process.env`. |
| `src/dataDir.js` | `createDataDir(dir)`: the **only** module that writes to disk. |
| `src/jsonlTail.js` | `readFrom(file, offset, {filter, onOpen})`: incremental JSONL reader. |
| `src/store/{sessions,ledger,costs}.js` | `loadSessions`, `LedgerReader`, `CostsReader`. |
| `src/backfill/{locate,extract,index}.js` | Transcript locate-by-backing-id, pure line extractor, incremental `BackfillIndex` with cache. |
| `src/model/{linkTypes,resolve,tree,links,bars,build}.js` | Catalog, id resolution, forest/grouping, link derivation, bar derivation, payload assembly. |
| `src/state.js` | Holds readers and the snapshot (`liveSet`, `version`); no payload logic. |
| `src/live.js` | `createLive`: store-stat poll, `/ws` hint, liveness fetch; network, timers injectable. |
| `src/http/app.js` | `createApp`: routes, static allowlist, security headers, SSE client cap. |
| `src/serial.js` | `createSerializer`: one-at-a-time async queue. |
| `public/` | Static frontend: `lib/` (pure `scale`, `layout`; `dom`, `api`, `format`), `render/` (`chart`, `filters`, `details`, `tooltip`), `app.js` (wiring), `main.js` (entry). |
| `harness/playwright/` | `golden-path.mjs`, `real-store.mjs`, `fixture-store.mjs`, `resolve.mjs`. |

## Data flow

`refreshStores()` (sessions whole, ledger + costs incrementally) → `BackfillIndex.scan()` (owner transcripts incrementally) → on request `buildPayload(state, window)`: `buildForest` → `groupByProject` → `buildLinks` → per-session `buildBar` → window filter → payload. `Live` bumps `state.version`; `/api/stream` forwards it.

## Rules

### Tree and grouping

- Root: no `parent`, or `parent` not in `sessions.json` (`orphan`). A parent loop is broken at its smallest id (that member becomes an orphan root) and counted in `diagnostics.treeLoops`.
- Childless roots are excluded. A tree is grouped under each project of its **descendants** (the root's own `project` never makes a group); the root and non-matching ancestors are `context` rows. The walk, cycle detection and grouping are iterative and O(n), so a very deep chain cannot overflow the stack.

### Bar end precedence

Defined in `buildBar`: kill/retire → live → approx. A kill after the last resume wins over a retire when it is at most `KILL_AFTER_RETIRE_MS` after that retire (or before it); `end` stays the retire ts. `live` requires `state.liveSet` (non-null); with liveness unavailable no bar is ever `live`.

### Link derivation (`buildLinks`)

- Spawn links come from `sessions.json` `parent`, at the child's start.
- A ledger `transition` draws a link itself (parent → session typed `via`; with `forwardSessionId`, `forward` from that session). Stage-moving calls write only a `transition`, not an `interaction`.
- A ledger `interaction` draws conductor → session typed by tool; tools outside `GOVERNED_TOOLS` become `other` and are counted in `unknownTools`.
- Backfill events at or after `LedgerReader.cutoffTs` (the first ledger `interaction` or `wake`) are dropped, so the ledger is authoritative from then on. Calls with `ok:false` or still pending are dropped.
- **Transition dedupe:** a backfill call or ledger interaction with the same target and tool as a transition's `via`, within ±120 s, is dropped; matching is one-to-one, nearest first.
- **Cutoff and twins (`buildLinks`):** a backfilled call's `ts` is its `tool_use` line, which precedes the handler (minutes for a parked `send_prompt`); its `rts` is its `tool_result` line. cc appends the ledger entry before it writes the result line, so a call whose `rts` is at or after `cutoffTs` always has its ledger entry: it is dropped before any id is resolved (so `unresolved` counts it once, through the ledger entry), and no pairing is needed or done for calls with an `rts`. A call before the cutoff is kept.
- **Pairing (wakes, and calls with no `rts`):** these carry only a time that may precede the ledger entry by an unknown skew. A backfill wake completing at or after the cutoff is dropped; one before it is dropped only if it is the twin of a ledger interaction/wake written just after the cutoff: same type, endpoints and heartbeat flag, within 30 s, paired one-to-one over every ledger entry near the cutoff, nearest first. Calls without an `rts` (a result line that carries no timestamp) follow the same rule; calls with an `rts` never pair. Trade-off: same-worker wakes within 30 s of each other do occur, so when the cutoff falls inside such a burst each ledger twin near the cutoff can take one genuine pre-cutoff wake in place of its own twin: at most one per ledger twin, only around the cutoff (`tests/model/links.test.mjs`, *H1*). A genuine `rts`-less call within the window can likewise be taken for a twin; it is a safety net for a case the transcripts do not normally produce. A paired event's unresolvable id is counted once, through the ledger entry; an unpaired one counts for itself.
- The backfill extractor and the ledger path share `GOVERNED_TOOLS`, so a tool is typed the same before and after the cutoff; a cached backfill tool outside the set is typed `other`.

### Id resolution

`resolveId` order: exact public id → backing id (`byBacking`) → unique prefix (≥ 4 chars) within the owner's tree → unique global prefix → unresolved (dropped, counted in `diagnostics.unresolved`). Ledger ids may be public or backing ids; ids of sessions removed from `sessions.json` are unresolved.

### Backfill

- Owners = sessions that are some session's `parent`. Their non-`dropped` segment ids are located by listing `<transcript root>/*/*.jsonl` (`buildBackingIndex`, refreshed once on a miss); cwd is never reconstructed.
- Prefilter substrings: `mcp__code-conductor__`, `[[cc:wake-callback]]`, `"tool_result"`.
- Prune segments overlap their predecessor: calls dedupe by `tool_use` id and wakes by line `uuid#block index`, per owner.
- A `tool_use` and its `tool_result` may fall in different passes; unmatched calls stay in `pending`.
- A scan requested while a pass runs is coalesced into one follow-up pass with the latest `sessions.json` snapshot, so a new owner is never skipped.
- The backing index is rebuilt at most once per pass. The cache is validated on load (see protocol) and rejected whole on any mismatch.
- Wake parsing is one bounded forward pass per line (see protocol for the caps); wake and call dedupe use key sets.
- The scan runs one file at a time in the background; `state.version` bumps every 25 files and at the end. The cache is persisted every 10 files and at the end.

## Incremental-read contract (`readFrom`)

- Reads `[offset, sizeAtOpen)`; bytes appended during the read wait for the next pass.
- Consumes complete lines only: a torn trailing line is left and re-read.
- `size < offset` → `reset: true`, re-read from 0.
- A malformed non-trailing line is skipped, listed in `corrupt` with its byte offset, logged, and counted in `diagnostics.corruptLines`.
- A missing file → `missing: true`, empty result.
- Ledger order is line position: `seq` repeats and regresses and is never used.

## Write confinement

- Only `src/dataDir.js` calls fs write APIs; every path is resolved, symlink-checked and must stay inside `CONDUCTOR_PLUGIN_DATA_DIR`. The directory is created `0700`; writes are tmp + rename.
- Enforced by `tests/safety/sourceScan.test.mjs` (no write API elsewhere in `src/` or `server.js`) and `tests/safety/readonly.test.mjs` (before/after snapshot of store and transcripts).

## Input-keyed maps

Keys that come from files (tool names, ledger kinds, session ids, tool_use ids) are never used on a plain `{}`: `unknownTools`, `unknownKinds` and the payload's `sessions` are built from a `Map`, and pending calls are looked up with `Object.hasOwn`. A key such as `constructor` is therefore ordinary data.

## Concurrency

`LedgerReader.refresh`, `CostsReader.refresh` and `state.refreshStores` are serialised (`src/serial.js`), and `Live.poll` runs one poll at a time: a call made mid-poll waits for it and queues one follow-up run. Concurrent calls therefore never read a line twice.

## Live refresh

Every 5 s `Live.poll` stats `sessions.json`, the ledger and `costs.jsonl`; a change re-reads and bumps the version, and re-scans the backfill. Transcripts of live owners are also stat-checked. With `CONDUCTOR_URL` set it connects (receive-only) to `<url>/ws`; a `{t:'instances'}` frame triggers, after a 500 ms debounce, a liveness fetch (`GET /api/instances`; a row is live unless `status` is `exited` or `crashed`) and a refresh. Reconnects back off from 0.5 s to 10 s, including after a failed `connect`. `CONDUCTOR_URL` must be a well-formed http(s) URL, otherwise it is ignored (liveness unavailable). The liveness fetch aborts after 3 s. `server.js` reads the stores and listens first; `Live.start` (liveness, `/ws`, polling) and the backfill run afterwards, so a slow or black-holed conductor never delays listening. Without `CONDUCTOR_URL`, or if the fetch fails, liveness is `unavailable`.

## Frontend security

- All DOM goes through `public/lib/dom.js` (`createElement(NS)` + `setAttribute` + text nodes); it refuses `on*`, `style`, `href`, `src*` attributes and script-like tags. No HTML-string APIs exist in `public/`.
- CSP blocks inline style, so geometry uses SVG attributes and the tooltip is an SVG `<g>` positioned by `transform`.
- URLs are relative; `lib/api.js` throws on a leading `/`. `index.html` loads only `/pluginBridge.js` and `/pluginTheme.css` root-relative (host-served; they 404 standalone).

## Tests

`npm test` runs `node --test` over `tests/**/*.test.mjs`, clearing the cc env vars first.

- **Fixture store:** `tests/helpers/store.mjs` `makeStore` builds a fresh temp store, transcript root and data dir; config is injected.
- **Sentinel:** `tests/helpers/sentinel.mjs` `PROMPT_SENTINEL` sits in every fixture prompt, wake body and tool result; extractor, cache, payload and DOM must not contain it.
- **Poison test:** after a read, earlier bytes are overwritten with same-length different content; a later pass must not see them (proves no re-read).
- **Injected fakes:** `Live` takes `fetch`, `connect` and `schedule`; tests fire timers by hand.
- **Gated:** `tests/gated/ccManifest.test.mjs` (`RUN_CC_MANIFEST=1`, `CC_PROJECTS_ROOT` set) validates the manifest with cc's own validator.

## First-scan duration

`npm run harness:real` (needs `CC_PROJECTS_ROOT`; read-only, runs the safety tests first) logs `first scan: N s`, the time from boot to `backfill.state === 'ready'`. On a developer machine with a local disk and a warm page cache the scan of the owner transcripts takes single-digit seconds; the time scales with the number and size of the transcripts, which each pass reads once (later passes read only appended bytes). What a scan could not read is reported in `diagnostics.backfill.missing` (segment files absent from the transcript root) and `diagnostics.backfill.droppedMarkers`.
