import fs from 'node:fs/promises';
import path from 'node:path';

function index(sessions) {
  const byId = new Map();
  const byBacking = new Map();
  const children = new Map();
  for (const [id, rec] of Object.entries(sessions)) {
    if (!rec || typeof rec !== 'object') continue;
    byId.set(id, { id, ...rec });
    for (const seg of rec.segments ?? []) if (seg?.id && !seg.dropped) byBacking.set(seg.id, id);
    if (rec.current) byBacking.set(rec.current, id);
  }
  for (const [id, rec] of byId) {
    if (!rec.parent) continue;
    if (!children.has(rec.parent)) children.set(rec.parent, []);
    children.get(rec.parent).push(id);
  }
  return { byId, byBacking, children };
}

/**
 * Reads sessions.json (wrapped `{sessions:{…}}`, written atomically by cc) whole.
 * On a parse failure the previous snapshot is kept and `error` is set.
 */
export async function loadSessions(storeDir, prev) {
  const file = path.join(storeDir, 'sessions.json');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...index({}), missing: true };
    throw err;
  }
  try {
    const doc = JSON.parse(text);
    return { ...index(doc.sessions ?? {}), missing: false };
  } catch (err) {
    const keep = prev ?? index({});
    return { byId: keep.byId, byBacking: keep.byBacking, children: keep.children, missing: false, error: `sessions.json unreadable: ${err.message}` };
  }
}
