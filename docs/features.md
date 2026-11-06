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
| `retired` | Last ledger `retire` with no later `resume`; `endReason` is shown in the details. |
| `killed` | A `kill_instance` link after the last resume (red outline). With a retire the bound is one-sided: the kill may be at most 5 s *after* the retire (cc writes the retire first and the kill interaction a moment later), or any time *earlier* as long as it is after the last resume (transcripts show the kill first); the end is then the retire time. A kill more than 5 s after the retire leaves the bar `retired`. |
| `live` | Session is live per cc's instance list; the bar extends to now. Requires `CONDUCTOR_URL`. |
| `approx` | None of the above. The end is the latest of: last turn, last ledger event naming the session, last link touching it, last segment start. Drawn with a hatched tail; tooltip and details say "approximate end". |

Bar content:

- **Turns:** darker segments from `costs.jsonl`.
- **Stage bands:** thin colour strip along the bottom, one band per playbook stage (spawn stage, then each transition); colour is stable per stage name.
- **Rotation markers:** diamonds for `renew` (blue) and `prune` (purple) segments after the first.
- **Retire/resume marks:** dots for intermediate retire (red) and resume (green) events.

## Links

Vertical connector at the event time from source row to target row, ending in a dot on the target; hover the dot for type, source and endpoints. Types are the payload's `linkTypes`; colours are defined per type in `public/style.css`.

| Type | Direction |
|---|---|
| `spawn` | parent → child, at the child's start |
| governed tools (`send_prompt`, `approve_plan`, `reject_plan`, `answer_question`, `interrupt_turn`, `kill_instance`, `set_mode`, `set_idle_timeout`, `renew_session`, `prune_session`) | conductor → worker |
| `forward` | forward source → target (a prompt that forwards another session's output) |
| `wake` | worker → conductor; heartbeat wakes (a worker that did not finish) are dotted |
| `other` | conductor → worker, for a ledger `interaction` whose tool is not in the governed set; counted in the footer |

## Controls

- **Range:** last 6 h / 24 h / 72 h / 7 d / 14 d (refetches the window).
- **Projects, Trees, Links:** checkboxes. `wake heartbeat` is independent of `wake`.
- **Zoom/pan:** wheel zooms around the cursor, drag pans; both clamped to the loaded window. *Reset zoom* restores the window.
- **Details panel:** click a bar for id, title, project, worktree, model, playbook, state, start/end, turn count, rotations and stage history.
- **Banner:** shows backfill progress while transcripts are being scanned.
- **Footer:** liveness state, backfill cutoff, unresolved ids, unknown ledger kinds/tools, corrupt lines, missing files.
- Updates arrive over SSE; the chart reloads when the server's version changes.

## Privacy

Prompt text, wake bodies and tool results are never extracted, cached, sent or rendered. Session titles are shown.
