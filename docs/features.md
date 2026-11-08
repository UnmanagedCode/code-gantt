# Features

## Rows and grouping

- Chart rows nest **project band → conductor → section lead → worker**. The order is fixed; there is no toggle.
- **Roles** (the payload's per-row `role`):
  - *Conductor*: a tree's root (a session with no parent, or an orphan whose parent is absent from `sessions.json`). Its own `project` is ignored. A root with no children is not a tree and is not shown.
  - *Section lead*: a depth-1 session whose `project` is the payload's `conductorProject` (`.conduct`), with or without workers.
  - *Worker*: every other session, including a `.conduct` session below depth 1.
- **Project bands:** a worker belongs to the band of its `project`. Bands sort by name, the conductor project first, labelled **Conductor** (also in the Projects menu). Under Conductor sit only the roots that have section leads, with their lead headers; a lead with no workers still shows there.
- **Headers repeat per band:** a conductor header (bold) appears in every band holding rows of its tree. A section lead appears in Conductor (its own row) and as a dimmed copy in each project band it drives. Workers sit at their tree depth under their lead (or under the conductor header, for the conductor's own workers).
- **Context rows** (italic, dimmed): a conductor, a lead copy, or a worker ancestor whose `project` is not the band's, kept so the tree keeps its structure.
- Within a band, trees follow tree start order; under a header, lead headers and workers follow tree start order. Nesting has no depth limit.

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

Vertical connector at the event time from source row to target row, ending in a dot on the target; hover the dot for type and endpoints. A link is drawn only inside one band:

- **Which band:** among the bands holding rows for both ends, the one where most ends have their own (non-dimmed) row; ties go to the first band. In it each end uses its own row, else its first row.
- **Exception — root ↔ its own section lead** (either direction): also drawn in every other band holding both, i.e. each project band the lead drives, between the dimmed root and lead copies. Never in a band the lead does not drive, and never stubbed.
- **Stubs:** when both ends are drawn but no band holds both, no line is drawn. Each end gets a short stub at the event time (`STUB_PX` long, pointing toward the other end's row) ending in a hollow ring; the target end keeps its dot. The stub sits on the end's own row, else its topmost dimmed copy. Hover the ring: the usual tooltip plus `<other end> — in <band>, not drawn here`.
- An end that is filtered out or outside the time range draws neither a line nor a stub. The type, heartbeat and legend filters hide stubs with their link.

The tooltip of either line of a forwarded prompt names sender → target and `forwarding <source>`. Types are the payload's `linkTypes`; colours are defined per type in `public/style.css`.

| Type | Direction |
|---|---|
| `spawn` | parent → child, at the child's start |
| governed tools (`send_prompt`, `approve_plan`, `reject_plan`, `answer_question`, `interrupt_turn`, `kill_instance`, `set_mode`, `set_idle_timeout`, `renew_session`, `prune_session`) | conductor → worker |
| `forward` | forward source → target, drawn alongside the `send_prompt` it belongs to (a prompt that forwards another session's output): solid, shifted right by a constant pixel offset (`PAIR_OFFSET_PX`) |
| `wake` | worker → conductor; heartbeat wakes (a worker that did not finish) are dotted |
| `other` | conductor → worker, for a `call` row whose tool is not in the governed set; counted in the footer |

## Controls

- **Range:** last 6 h / 24 h / 72 h / 7 d / 14 d (refetches the window).
- **Conductors, Projects, Links** (in that order; a tree is keyed by its conductor): one dropdown popover each (button shows `Label · All`, `Label · None` or `Label · n of m`). Each has a search box, *All* / *None* (acting on the rows the search leaves visible) and an *only* button per row. One popover is open at a time; it stays open across toggles and live reloads, and closes on Esc, a click outside, or Tab out.
- **Order:** Conductors lists trees by root start; Projects lists the conductor project first, then by name.
- **Narrowing:** Projects lists only the projects the selected conductors' trees touch (a tree with workers in several projects counts for each); under Conductors *All* it lists every project. Stored Projects choices for hidden projects are kept and return when the Conductors selection widens. *All* / *None* / *only* in Projects act only on listed projects (*All* / *None* also only search-visible ones). Projects never narrows Conductors. Under Conductors *None*, Projects lists nothing and says so.
- **Selection semantics:** *All* means every project/conductor, including ones that appear after load (range change, live data). An explicit subset keeps new items hidden, and its button reads `n of m` even when the subset happens to cover every current item (only the real All reads `All`). An empty Conductors or Projects selection draws no rows; the chart hint names which filter is empty. Filter state is in memory only; a page reload resets it.
- **Crosshair:** hovering the time scale's plot area shows a vertical line through the scale and the visible rows, and a readout `MM-DD HH:MM` in local time, with `:SS` when one pixel spans at most `READOUT_SECONDS_MS_PER_PX` (`public/lib/scale.js`). It follows the pointer during a drag-to-zoom (clamped to the plot) and stays at the pointer across reloads and wheel zoom. It hides when the pointer leaves the scale or is over the label column, after a press ends or is cancelled until the next move.
- **Link groups:** the Links popover groups types by kind (`LINK_GROUPS` in `public/lib/linkGroups.js`): Lifecycle, Driving, Plans, Wakes, Config, Other. A type missing from the table goes to Other. Each group has a tri-state checkbox and a disclose button (collapsed by default; while a search is active matching groups are expanded and the disclose buttons are disabled). `wake heartbeat` is an item of Wakes, independent of `wake`.
- **Legend:** a row of buttons under the toolbar, one per link type in the popover's order (only the `wake heartbeat` swatch is dotted, like its line); click toggles the type (muted + struck through when hidden). It shares state with the Links popover.
- **Keyboard:** ArrowDown on a menu button opens it; ArrowDown/ArrowUp move between row checkboxes (and the search box); ArrowRight/ArrowLeft expand/collapse a group; Space toggles; Esc closes and refocuses the button.
- **Layout:** the page never scrolls. A tall chart scrolls its rows inside the chart box while the toolbar, legend, time scale and footer stay visible; the details panel scrolls on its own when long. The scroll position is kept across live reloads, resizes, zoom and filter changes.
- **Zoom/pan:** Ctrl/⌘+wheel (or trackpad pinch) over the rows zooms around the cursor, and a plain wheel over the time scale zooms; a plain wheel over the rows scrolls them, so Ctrl+wheel over the chart no longer zooms the browser page; **drag across the time scale to zoom to that interval** (a band shows the selection; a click or a drag under `BRUSH_MIN_PX` in `public/lib/scale.js` does nothing; Esc or a pointer cancel aborts); drag on the rows pans. All are clamped to the loaded window. The Range select keeps showing the loaded range; *Reset zoom* or choosing a range restores the full window.
- **Details panel:** click a bar for id, title, project, worktree, model, playbook, state, start/end, turn count, rotations and stage history.
- **Banner:** says so when the event log has no complete history yet (nothing is drawn).
- **Footer:** liveness state, history from (the horizon), unresolved ids, rows of deleted sessions, unknown event kinds/tools, other-version rows (only when present), corrupt lines, missing files.
- Updates arrive over SSE; the chart reloads when the server's version changes.

## Privacy

Prompt text, wake bodies and tool results are never extracted, cached, sent or rendered. Session titles are shown.
