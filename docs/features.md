# Features

## Rows and grouping

- Chart rows: **project header → tree rows**. A tree's root is the conductor (a session with no parent, or an orphan whose parent is absent from `sessions.json`).
- A root with no children is not a tree and is not shown.
- Roots carry no `project`; a tree is attributed to every project of its descendants. In each project group the rows are that project's sessions plus all their ancestors; ancestors outside the project are **context** rows (italic, dimmed).
- A tree's projects come from its descendants only; the root appears in a group only as a context row, whatever `project` its record carries.
- Children are ordered by start; nesting has no depth limit.

## Bars

| End kind | Meaning |
|---|---|
| `exited` | Last `session` `exit` row after the last `start`/`resume`, by a `system` actor with no kill link; `endReason` is the row's `cause`, shown in the details. |
| `killed` | (red outline) The ending `exit` row's actor is a `conductor` (`kill_instance`) or a `human` (UI kill); or a `system` exit with a `kill_instance` link within 5 s of it, either order (migrated exits are all `system`); the end is the exit time. With no exit, a `kill_instance` link after the last `start`/`resume` ends the bar at the kill time. A kill link more than 5 s from a `system` exit leaves the bar `exited`. |
| `live` | Session is live per cc's instance list; the bar extends to now. Requires `CONDUCTOR_URL`. |
| `approx` | None of the above. The end is the latest of: last turn, last event-log row naming the session, last link touching it, last segment start. Drawn with a hatched tail; tooltip and details say "approximate end". |

Bar content:

- **Turns:** darker segments from the event log's `turn` rows (a turn still open runs to the bar's end).
- **Horizon:** nothing before the horizon (the moment the event log is complete for links and turns; shown in the footer) is drawn. A bar spanning it starts there with the stage it held; sessions that ended earlier are absent, or label-only when they are ancestors of a visible session.
- **Stage bands:** thin colour strip along the bottom, one band per playbook stage (the `bind` stage, then each `move`; a second `bind` restarts the bands); colour is stable per stage name.
- **Rotation markers:** diamonds for `renew` (blue) and `prune` (purple) segments after the first.
- **Exit/resume marks:** dots for intermediate `session` `exit` (red) and `resume` (green) rows.

## Links

Vertical connector at the event time from source row to target row, ending in a dot on the target; hover the dot for type and endpoints. Types are the payload's `linkTypes`; colours are defined per type in `public/style.css`.

| Type | Direction |
|---|---|
| `spawn` | parent → child, at the child's start |
| governed tools (`send_prompt`, `approve_plan`, `reject_plan`, `answer_question`, `interrupt_turn`, `kill_instance`, `set_mode`, `set_idle_timeout`, `renew_session`, `prune_session`) | conductor → worker |
| `forward` | forward source → target (a prompt that forwards another session's output) |
| `wake` | worker → conductor; heartbeat wakes (a worker that did not finish) are dotted |
| `other` | conductor → worker, for a `call` row whose tool is not in the governed set; counted in the footer |

## Controls

- **Range:** last 6 h / 24 h / 72 h / 7 d / 14 d (refetches the window).
- **Projects, Trees, Links:** one dropdown popover each (button shows `Label · All`, `Label · None` or `Label · n of m`). Each has a search box, *All* / *None* (acting on the rows the search leaves visible) and an *only* button per row. One popover is open at a time; it stays open across toggles and live reloads, and closes on Esc, a click outside, or Tab out.
- **Selection semantics:** *All* means every project/tree, including ones that appear after load (range change, live data). An explicit subset keeps new items hidden, and its button reads `n of m` even when the subset happens to cover every current item (only the real All reads `All`). An empty Projects or Trees selection draws no rows and the chart area shows a hint. Filter state is in memory only; a page reload resets it.
- **Crosshair:** hovering the time scale's plot area shows a vertical line through the scale and the visible rows, and a readout `MM-DD HH:MM` in local time, with `:SS` when one pixel spans at most `READOUT_SECONDS_MS_PER_PX` (`public/lib/scale.js`). It follows the pointer during a drag-to-zoom (clamped to the plot) and stays at the pointer across reloads and wheel zoom. It hides when the pointer leaves the scale or is over the label column, after a press ends or is cancelled until the next move.
- **Link groups:** the Links popover groups types by kind (`LINK_GROUPS` in `public/lib/linkGroups.js`): Lifecycle, Driving, Plans, Wakes, Config, Other. A type missing from the table goes to Other. Each group has a tri-state checkbox and a disclose button (collapsed by default; while a search is active matching groups are expanded and the disclose buttons are disabled). `wake heartbeat` is an item of Wakes, independent of `wake`.
- **Legend:** a row of buttons under the toolbar, one per link type in the popover's order; click toggles the type (muted + struck through when hidden). It shares state with the Links popover.
- **Keyboard:** ArrowDown on a menu button opens it; ArrowDown/ArrowUp move between row checkboxes (and the search box); ArrowRight/ArrowLeft expand/collapse a group; Space toggles; Esc closes and refocuses the button.
- **Layout:** the page never scrolls. A tall chart scrolls its rows inside the chart box while the toolbar, legend, time scale and footer stay visible; the details panel scrolls on its own when long. The scroll position is kept across live reloads, resizes, zoom and filter changes.
- **Zoom/pan:** Ctrl/⌘+wheel (or trackpad pinch) over the rows zooms around the cursor, and a plain wheel over the time scale zooms; a plain wheel over the rows scrolls them, so Ctrl+wheel over the chart no longer zooms the browser page; **drag across the time scale to zoom to that interval** (a band shows the selection; a click or a drag under `BRUSH_MIN_PX` in `public/lib/scale.js` does nothing; Esc or a pointer cancel aborts); drag on the rows pans. All are clamped to the loaded window. The Range select keeps showing the loaded range; *Reset zoom* or choosing a range restores the full window.
- **Details panel:** click a bar for id, title, project, worktree, model, playbook, state, start/end, turn count, rotations and stage history.
- **Banner:** says so when the event log has no complete history yet (nothing is drawn).
- **Footer:** liveness state, history from (the horizon), unresolved ids, rows of deleted sessions, unknown event kinds/tools, other-version rows (only when present), corrupt lines, missing files.
- Updates arrive over SSE; the chart reloads when the server's version changes.

## Privacy

Prompt text, wake bodies and tool results are never extracted, cached, sent or rendered. Session titles are shown.
