import { el } from '../lib/dom.js';
import { HEARTBEAT_KEY } from '../lib/filterModel.js';

const DOTTED = new Set([HEARTBEAT_KEY]);

/** Colour key for a link type; only heartbeat is drawn dotted, like its line. */
export const swatch = (key) => el('span', { class: DOTTED.has(key) ? 'swatch dotted' : 'swatch', 'data-type': key });
