import { el, clear } from '../lib/dom.js';
import { fmtTime, labelOf } from '../lib/format.js';

export const END_LABEL = { retired: 'retired', killed: 'killed', live: 'live', approx: '≈ approximate end' };

function row(dt, dd) {
  return [el('dt', null, dt), el('dd', null, dd)];
}

/** Fills the details region with one session (or a hint). Text nodes only. */
export function renderDetails(host, s) {
  clear(host);
  if (!s) {
    host.appendChild(el('p', { class: 'hint' }, 'Select a bar to see its details.'));
    return;
  }
  const end = s.endKind === 'approx'
    ? `${fmtTime(s.end)} (≈ approximate end: no retire event, not live)`
    : s.endKind === 'live' ? 'live (still running)' : `${fmtTime(s.end)}${s.endReason ? ` (${s.endReason})` : ''}`;
  host.appendChild(el('h2', null, labelOf(s)));
  host.appendChild(el('dl', null,
    row('ID', s.id),
    row('Project', s.project ?? '–'),
    row('Worktree', s.worktree ?? '–'),
    row('Model', s.model ?? '–'),
    row('Playbook', s.playbook ?? '–'),
    row('State', END_LABEL[s.endKind] ?? s.endKind),
    row('Started', fmtTime(s.start)),
    row('Ended', end),
    row('Turns', String(s.turnCount)),
    row('Rotations', String(s.rotations.length)),
  ));
  host.appendChild(el('h3', null, 'Stage history'));
  host.appendChild(s.stages.length
    ? el('ol', { class: 'stages' }, s.stages.map((g) => el('li', null, `${g.stage}  ${fmtTime(g.from)} → ${g.to == null ? 'now' : fmtTime(g.to)}${g.via ? `  via ${g.via}` : ''}`)))
    : el('p', { class: 'hint' }, 'No playbook stages recorded.'));
}
