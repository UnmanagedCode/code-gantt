# Code Gantt

A [code-conductor](https://github.com) (cc) plugin that shows conducted session trees as a Gantt chart, grouped **project → tree**. It is for anyone supervising conductors and workers who wants to see *when* sessions ran, how they were driven, and how they relate.

## What it shows

- **Rows:** a conductor and its workers (nested leads included), one bar per session. A tree that touches several projects appears under each of them; ancestors outside the group are dimmed.
- **Bars:** start → end. The end is `exited`, `killed`, `live`, or **approximate** (hatched tail + "approximate end" in tooltip and details). Turn segments, renew/prune rotation markers and playbook stage bands are drawn on the bar.
- **Links:** typed connectors between sessions at the time of the interaction (spawn, prompts, forwards, plan approve/reject, answers, interrupts, kills, mode/idle-timeout/renew/prune, wakes). Unknown tools show as `other`.
- **Controls:** date range, project, tree and link-type filters; a separate toggle for heartbeat wakes; wheel zoom and drag pan; click a bar for details.

Details: [docs/features.md](docs/features.md).

## Technical summary

- Node ≥ 22.18, **no runtime dependencies**, no build step; plain ES-module frontend served as static files. `happy-dom` is the only devDependency (DOM/XSS tests).
- Reads cc's store (`sessions.json`, `events.jsonl`, `costs.jsonl`) and conductor transcripts **read-only**; the only write location is `CONDUCTOR_PLUGIN_DATA_DIR`.
- Links come from the event log where it names the caller, and are backfilled from transcripts for the time before. Turns come from the log's `turn` rows, and from `costs.jsonl` before the first one.

Contracts: [docs/protocol.md](docs/protocol.md). Internals: [docs/architecture.md](docs/architecture.md).

## Run and test

| Command | Purpose |
|---|---|
| `npm start` | Serve on `$PORT` (default 7300, loopback). Needs `PROJECTS_ROOT` and `CONDUCTOR_PLUGIN_DATA_DIR`; exits non-zero without the latter. |
| `npm test` | Full suite against fixture stores only (clears the cc env vars first). |
| `npm run harness` | Playwright golden path on a synthetic store; screenshots in `harness/playwright/screenshots/`. |
| `npm run harness:real` | Renders the real store read-only; needs `CC_PROJECTS_ROOT`. |

| Env var | Meaning |
|---|---|
| `PROJECTS_ROOT` | cc projects root; the store is `<root>/.code-conductor/`. |
| `CONDUCTOR_PLUGIN_DATA_DIR` | The plugin's only writable directory (backfill cache). |
| `CLAUDE_PROJECTS_ROOT` / `CLAUDE_CONFIG_DIR` / `HOME` | Transcript root: `CLAUDE_PROJECTS_ROOT`, else `<CLAUDE_CONFIG_DIR or $HOME/.claude>/projects`. |
| `CONDUCTOR_URL` | cc base URL for liveness (`GET /api/instances`) and the `/ws` change hint. Unset → no bar is open-ended. |
| `PORT` | Listen port. |

Install in cc: Settings → Plugins → Rescan → Enable. After a plugin code change, restart it via `POST /api/plugins/code-gantt/restart`.

## Known limitations

- Transcripts of remote projects are not scanned.
- Sessions deleted from `sessions.json` are not shown. Their event-log rows and cost rows are dropped and counted in `diagnostics.unmatchedStoreRows` (shown in the footer); transcript-derived ids that cannot be resolved are counted in `diagnostics.unresolved`.
- Without a `session` exit (untracked exits, a host reboot) or liveness, a bar ends at an approximate end.
- Migrated `call` rows carry no caller and draw no link; the transcript backfill covers that history.
- The event log has no `turn` rows before its first one; turns before it come from `costs.jsonl`.
- The first backfill scan runs in the background; links appear progressively.
