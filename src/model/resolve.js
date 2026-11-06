const MIN_PREFIX = 4;

function uniquePrefix(raw, ids) {
  let hit = null;
  for (const id of ids) {
    if (!id.startsWith(raw)) continue;
    if (hit) return null;
    hit = id;
  }
  return hit;
}

/**
 * Resolves a raw session id (public, backing, or prefix) to a public id.
 * Order: exact public id → backing id → unique prefix within `scope` (the owner's tree) → unique global prefix.
 * @param {string} raw
 * @param {{byId: Map<string, any>, byBacking: Map<string, string>, scope?: Set<string>|null}} ctx
 * @returns {string|null}
 */
export function resolveId(raw, { byId, byBacking, scope }) {
  if (typeof raw !== 'string' || raw === '') return null;
  if (byId.has(raw)) return raw;
  if (byBacking.has(raw)) return byBacking.get(raw);
  if (raw.length < MIN_PREFIX) return null;
  if (scope) {
    const hit = uniquePrefix(raw, scope);
    if (hit) return hit;
  }
  return uniquePrefix(raw, byId.keys());
}
