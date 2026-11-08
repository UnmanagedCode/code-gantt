import { el } from '../lib/dom.js';
import { HEARTBEAT_KEY } from '../lib/filterModel.js';

const DOTTED = new Set([HEARTBEAT_KEY, 'forward']);

/** Colour key for a link type; heartbeat and forward are drawn dotted, like their lines. */
export const swatch = (key) => el('span', { class: DOTTED.has(key) ? 'swatch dotted' : 'swatch', 'data-type': key });
