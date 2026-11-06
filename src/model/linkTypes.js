/**
 * Governed cc tools that move a session and are recorded as ledger `interaction` events
 * (every governed tool that declares `sessionId` and is not read-only).
 * The backfill extractor and the ledger link builder both read this list.
 */
export const GOVERNED_TOOLS = [
  'send_prompt', 'approve_plan', 'reject_plan', 'answer_question', 'interrupt_turn', 'kill_instance',
  'set_mode', 'set_idle_timeout', 'renew_session', 'prune_session',
];

/** Fallback type for a ledger `interaction` whose tool is not in GOVERNED_TOOLS. */
export const OTHER_LINK_TYPE = 'other';

/** Single source of every link type; sent in the payload so the frontend never duplicates it. */
export const LINK_TYPES = ['spawn', ...GOVERNED_TOOLS, 'forward', 'wake', OTHER_LINK_TYPE];
