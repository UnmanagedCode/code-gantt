import { el } from '../lib/dom.js';
import { HEARTBEAT_KEY } from '../lib/filterModel.js';

/** Colour key for a link type; heartbeat is drawn dotted, like its line. */
export const swatch = (key) => el('span', { class: key === HEARTBEAT_KEY ? 'swatch dotted' : 'swatch', 'data-type': key });
