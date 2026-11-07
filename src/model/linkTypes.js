/**
 * Governed cc tools that move a session and are recorded as event-log `call` rows
 * (every interaction tool: it declares `sessionId` and is not read-only).
 * The backfill extractor and the event-log link builder both read this list.
 */
export const GOVERNED_TOOLS = [
  'send_prompt', 'approve_plan', 'reject_plan', 'answer_question', 'interrupt_turn', 'kill_instance',
  'set_mode', 'set_idle_timeout', 'renew_session', 'prune_session',
];

/** Fallback type for a `call` row whose tool is not in GOVERNED_TOOLS. */
export const OTHER_LINK_TYPE = 'other';

/** Single source of every link type; sent in the payload so the frontend never duplicates it. */
export const LINK_TYPES = ['spawn', ...GOVERNED_TOOLS, 'forward', 'wake', OTHER_LINK_TYPE];
