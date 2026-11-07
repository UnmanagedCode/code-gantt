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

- **Turns:** darker segments from the event log's `turn` rows (a turn still open runs to the bar's end); before the log's first `turn` row, from `costs.jsonl`.
- **Stage bands:** thin colour strip along the bottom, one band per playbook stage (the `bind` stage, then each `move`; a second `bind` restarts the bands); colour is stable per stage name.
- **Rotation markers:** diamonds for `renew` (blue) and `prune` (purple) segments after the first.
- **Exit/resume marks:** dots for intermediate `session` `exit` (red) and `resume` (green) rows.

## Links

Vertical connector at the event time from source row to target row, ending in a dot on the target; hover the dot for type, source and endpoints. Types are the payload's `linkTypes`; colours are defined per type in `public/style.css`.

| Type | Direction |
|---|---|
| `spawn` | parent → child, at the child's start |
| governed tools (`send_prompt`, `approve_plan`, `reject_plan`, `answer_question`, `interrupt_turn`, `kill_instance`, `set_mode`, `set_idle_timeout`, `renew_session`, `prune_session`) | conductor → worker |
| `forward` | forward source → target (a prompt that forwards another session's output) |
| `wake` | worker → conductor; heartbeat wakes (a worker that did not finish) are dotted |
| `other` | conductor → worker, for a `call` row whose tool is not in the governed set; counted in the footer |

## Controls

- **Range:** last 6 h / 24 h / 72 h / 7 d / 14 d (refetches the window).
- **Projects, Trees, Links:** checkboxes. `wake heartbeat` is independent of `wake`.
- **Zoom/pan:** wheel zooms around the cursor, drag pans; both clamped to the loaded window. *Reset zoom* restores the window.
- **Details panel:** click a bar for id, title, project, worktree, model, playbook, state, start/end, turn count, rotations and stage history.
- **Banner:** shows backfill progress while transcripts are being scanned.
- **Footer:** liveness state, backfill cutoff, unresolved ids, rows of deleted sessions, unknown event kinds/tools, other-version rows (only when present), corrupt lines, missing files.
- Updates arrive over SSE; the chart reloads when the server's version changes.

## Privacy

Prompt text, wake bodies and tool results are never extracted, cached, sent or rendered. Session titles are shown.
