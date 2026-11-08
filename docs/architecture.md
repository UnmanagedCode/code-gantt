# Architecture

## Module map

| Path | Responsibility |
|---|---|
| `server.js` | Thin: resolve config, build state, start `Live`, listen on `127.0.0.1:$PORT||7300`. Exits non-zero if `PROJECTS_ROOT` is unset. |
| `src/config.js` | `resolveConfig(env)`: `projectsRoot`, `storeDir`, `conductorUrl`. Library code never reads `process.env`. |
| `src/jsonlTail.js` | `readFrom(file, offset, {onOpen})`: incremental JSONL reader. |
| `src/store/{sessions,events}.js` | `loadSessions`, `EventLogReader` (`events.jsonl`; exposes `horizonTs`). |
| `src/model/{linkTypes,resolve,tree,links,bars,turns,build}.js` | Catalog, id resolution, forest/grouping, link derivation, bar derivation, `turn`-row folding (`buildTurns`), payload assembly. |
| `src/state.js` | Holds readers and the snapshot (`liveSet`, `version`); no payload logic. |
| `src/live.js` | `createLive`: store-stat poll, `/ws` hint, liveness fetch; network, timers injectable. |
| `src/http/app.js` | `createApp`: routes, static allowlist, security headers, SSE client cap. |
| `src/serial.js` | `createSerializer`: one-at-a-time async queue. |
| `public/` | Static frontend: `lib/` (pure `scale`, `layout`, `selection`, `filterModel`, `linkGroups`; `dom`, `api`, `format`), `render/` (`chart`, `filters`, `filterMenu`, `legend`, `swatch`, `details`, `tooltip`), `app.js` (wiring), `main.js` (entry). |
| `harness/playwright/` | `golden-path.mjs`, `real-store.mjs`, `fixture-store.mjs`, `resolve.mjs`. |

## Data flow

`refreshStores()` (sessions whole, event log incrementally) → on request `buildPayload(state, window)`: horizon (none, or a requested window ending before it → empty payload; else the window's `from` is raised to it) → `buildForest` → `groupByProject` → `buildLinks` → `buildTurns` → per-session `buildBar` → window filter → `clipToHorizon` → payload. `Live` bumps `state.version`; `/api/stream` forwards it.

## Rules

### Horizon

- `EventLogReader.horizonTs` = the later of the `ts` of the first `wake` row or first `call` row with `actor.sessionId` (the first row in line order) and the `ts` of the first `turn` row. `null` while either is missing; cleared on a truncation reset. No date is hardcoded.
- `buildPayload` with no horizon, or with a requested `to` before it, returns no projects, sessions or links and the requested window, unclamped. `diagnostics.horizon` is `null` without a horizon and stays set otherwise. The frontend banner says there is no complete history only for `null`.
- Otherwise (`to` at or after the horizon) the horizon is a floor on the window: `from = max(from, horizon)`, and `window.from` reports the clamped value. The window filter then drops bars that ended earlier, clips turns, and drops links before it (spawn links at a pre-horizon child start included). Frontend zoom/pan bounds are `window`, so nothing earlier can be reached.
- Clipping is output-only. Bars, `namedMax`, `linkTs` and `kills` are derived from the whole log, so a pre-horizon exit, kill or last mention still ends a bar (and hides it) instead of turning it into a false `approx` or `live` bar.
- `clipToHorizon(bar, h)` (`src/model/bars.js`): a bar ending at or after `h` starts at `h`, keeps marks and rotations with `at >= h`, drops stage bands ending at or before `h`, and the band held at `h` starts at `h` (its `stage` and `via` kept; `playbook` kept). A bar ending before `h` (only a context row can) keeps `start`/`end`/`endKind` and has empty marks, rotations, stages and turns: a label-only row.
- Hidden ancestors: the forest is built from all of `sessions.json` and the row rule is unchanged. A hidden same-project parent is dropped and its visible child keeps its `depth`; a hidden root or other-project ancestor stays as a `context` row so the tree keeps its structure and `rootId` resolves in `sessions`. A tree is shown only when a non-context row is visible.
- `turnCount` is `turnEndSeq` (lifetime, from `sessions.json`) else the event-log turn count, so it can exceed the turns drawn on a clipped bar.

### Tree and grouping

- Root: no `parent`, or `parent` not in `sessions.json` (`orphan`). A parent loop is broken at its smallest id (that member becomes an orphan root) and counted in `diagnostics.treeLoops`.
- Childless roots are excluded. A tree is grouped under each project of its **descendants** (the root's own `project` never makes a group); the root and non-matching ancestors are `context` rows. The walk, cycle detection and grouping are iterative and O(n), so a very deep chain cannot overflow the stack.

### Bar end precedence

Defined in `buildBar`: killed/exited → live → approx. The ending row is the last `session` `exit` after the last `start`/`resume`. An exit by a `conductor` or `human` actor is `killed`; a `system` exit is `killed` only when a `kill_instance` link lands within `KILL_AFTER_EXIT_MS` of it (either order), else `exited`. `end` is the exit ts. A kill link after the last life began with no exit is `killed` at the kill ts. `live` requires `state.liveSet` (non-null); with liveness unavailable no bar is ever `live`.

### Stage bands

`bind` on a `call` row replaces the bands and the playbook; `move` appends a band (`via` = the call's tool) unless `move.to` is the stage already held. A refused row that carries either is folded too (under `warn` it is the call's only row).

### Turns

`buildTurns` folds `turn` rows per resolved `subject` in line order: `start` opens, `end` closes, a second `start` closes the open turn at the new start, an `end` with no open turn is ignored, and a `session` row of the same subject closes an open turn (a reboot writes no `end`). A turn open at the end of the log has end `null`; `buildPayload` sizes it to the bar's end (`now` while live) after the bar is built.

### Link derivation (`buildLinks`)

- Spawn links come from `sessions.json` `parent`, at the child's start; `spawn_instance` `call` rows draw nothing.
- A `call` row draws caller (`actor.sessionId`) → `subject` typed by tool only when `outcome` is `ok` and the row names its caller; an unattributed (migrated) row draws nothing and counts nothing. With `forward` the type is `forward` and the source is that session. Tools outside `GOVERNED_TOOLS` become `other` and are counted in `unknownTools`.
- A `wake` row draws `subject` (worker) → `recipient`.

### Id resolution

`resolveId` order: exact public id → backing id (`byBacking`) → unique prefix (≥ 4 chars) within the owner's tree → unique global prefix → unresolved (dropped, counted in `diagnostics.unresolved`). Event-log ids are public ids; ids of sessions removed from `sessions.json` are unresolved.

## Incremental-read contract (`readFrom`)

- Reads `[offset, sizeAtOpen)`; bytes appended during the read wait for the next pass.
- Consumes complete lines only: a torn trailing line is left and re-read.
- `size < offset` → `reset: true`, re-read from 0.
- A malformed non-trailing line is skipped, listed in `corrupt` with its byte offset, logged, and counted in `diagnostics.corruptLines`.
- A missing file → `missing: true`, empty result.
- Event-log order is line position; there is no sequence number.

## No writes

- The plugin has no write path: no module in `src/` or `server.js` calls an fs write API.
- Enforced by `tests/safety/sourceScan.test.mjs` (no write API in `src/` or `server.js`) and `tests/safety/readonly.test.mjs` (a full run leaves the whole temp root identical).

## Input-keyed maps

Keys that come from files (tool names, event kinds, session ids) are never used on a plain `{}`: `unknownTools`, `unknownKinds` and the payload's `sessions` are built from a `Map`. A key such as `constructor` is therefore ordinary data.

## Concurrency

`EventLogReader.refresh` and `state.refreshStores` are serialised (`src/serial.js`), and `Live.poll` runs one poll at a time: a call made mid-poll waits for it and queues one follow-up run. Concurrent calls therefore never read a line twice.

## Live refresh

Every 5 s `Live.poll` stats `sessions.json` and `events.jsonl`; a change re-reads and bumps the version. With `CONDUCTOR_URL` set it connects (receive-only) to `<url>/ws`; a `{t:'instances'}` frame triggers, after a 500 ms debounce, a liveness fetch (`GET /api/instances`; a row is live unless `status` is `exited` or `crashed`) and a refresh. Reconnects back off from 0.5 s to 10 s, including after a failed `connect`. `CONDUCTOR_URL` must be a well-formed http(s) URL, otherwise it is ignored (liveness unavailable). The liveness fetch aborts after 3 s. `server.js` reads the stores and listens first; `Live.start` (liveness, `/ws`, polling) runs afterwards, so a slow or black-holed conductor never delays listening. Without `CONDUCTOR_URL`, or if the fetch fails, liveness is `unavailable`.

## Frontend filter state

- `state.filters` in `public/app.js` is the only store. `lib/filterModel.js` is the only adapter between it and the popovers/legend.
- `projects`/`roots`: `null` = All, a `Set` = exactly those keys, an empty `Set` = none (`wants` in `lib/layout.js`). `applySelection` collapses a set covering every current item back to `null`.
- Links: an explicit `linkTypes` Set plus the `heartbeat` boolean; `HEARTBEAT_KEY` is the pseudo-item the UI uses for it.
- `render/filters.js`, `filterMenu.js` and `legend.js` are built once and updated in place, so open state and focus survive renders.
- `tests/ui/linkGroups.test.mjs` fails when a type in `src/model/linkTypes.js` `LINK_TYPES` is missing from `LINK_GROUPS`.

## Frontend security

- All DOM goes through `public/lib/dom.js` (`createElement(NS)` + `setAttribute` + text nodes); it refuses `on*`, `style`, `href`, `src*` attributes and script-like tags. No HTML-string APIs exist in `public/`.
- CSP blocks inline style, so geometry uses SVG attributes and the tooltip is an SVG `<g>` positioned by `transform`.
- URLs are relative; `lib/api.js` throws on a leading `/`. `index.html` loads only `/pluginBridge.js` and `/pluginTheme.css` root-relative (host-served; they 404 standalone).

## Tests

`npm test` runs `node --test` over `tests/**/*.test.mjs`, clearing the cc env vars first.

- **Fixture store:** `tests/helpers/store.mjs` `makeStore` builds a fresh temp store; config is injected. `horizonRows(ts, worker, conductor)` emits the wake and turn rows that open the horizon. Its `evCall`/`evSession`/`evTurn`/`evWake`/`evConfig` builders emit rows shaped per cc `docs/event-log.md`.
- **Sentinel:** `tests/helpers/sentinel.mjs` `PROMPT_SENTINEL` sits in unknown row fields; payload and DOM must not contain it.
- **Poison test:** after a read, earlier bytes are overwritten with same-length different content; a later pass must not see them (proves no re-read).
- **Injected fakes:** `Live` takes `fetch`, `connect` and `schedule`; tests fire timers by hand.
- **Gated:** `tests/gated/ccManifest.test.mjs` (`RUN_CC_MANIFEST=1`, `CC_PROJECTS_ROOT` set) validates the manifest with cc's own validator.

## Real-store harness

`npm run harness:real` (needs `CC_PROJECTS_ROOT`; read-only, runs the safety tests first) boots against the real store, logs `diagnostics.horizon` and the counts, and asserts every link is at or after the horizon.
