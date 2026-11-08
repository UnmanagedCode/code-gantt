// Presentation grouping of link types for the Links filter and legend.
// Keys not listed here (a type newer than this table) land in the CATCH_ALL_GROUP group.
import { HEARTBEAT_KEY } from './filterModel.js';

export const CATCH_ALL_GROUP = 'other';

export const LINK_GROUPS = [
  { id: 'lifecycle', label: 'Lifecycle', members: ['spawn', 'kill_instance'] },
  { id: 'driving', label: 'Driving', members: ['send_prompt', 'forward', 'interrupt_turn'] },
  { id: 'plans', label: 'Plans', members: ['approve_plan', 'reject_plan', 'answer_question'] },
  { id: 'wakes', label: 'Wakes', members: ['wake', HEARTBEAT_KEY] },
  { id: 'config', label: 'Config', members: ['set_mode', 'set_idle_timeout', 'renew_session', 'prune_session'] },
  { id: CATCH_ALL_GROUP, label: 'Other', members: ['other'] },
];

/** [{key,label}] → [{id,label,items}] in table order; unknown keys go last in the catch-all; empty groups omitted. */
export function groupLinkItems(items) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const known = new Set(LINK_GROUPS.flatMap((g) => g.members));
  return LINK_GROUPS.map((g) => {
    const own = g.members.filter((k) => byKey.has(k)).map((k) => byKey.get(k));
    const extra = g.id === CATCH_ALL_GROUP ? items.filter((i) => !known.has(i.key)) : [];
    return { id: g.id, label: g.label, items: [...own, ...extra] };
  }).filter((g) => g.items.length > 0);
}
