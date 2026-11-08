// Pure set operations over item keys, shared by the filter popovers and the legend.

export function summary(label, selectedCount, total) {
  if (selectedCount === total) return `${label} · All`;
  if (selectedCount === 0) return `${label} · None`;
  return `${label} · ${selectedCount} of ${total}`;
}

export const matches = (label, query) => String(label).toLowerCase().includes(query.trim().toLowerCase());

export const selectAll = (selected, keys) => new Set([...selected, ...keys]);

export function selectNone(selected, keys) {
  const drop = new Set(keys);
  return new Set([...selected].filter((k) => !drop.has(k)));
}

export const only = (key) => new Set([key]);

export function toggle(selected, key, on) {
  const next = new Set(selected);
  if (on) next.add(key); else next.delete(key);
  return next;
}

export function triState(selected, keys) {
  if (keys.length === 0) return 'none';
  const n = keys.filter((k) => selected.has(k)).length;
  if (n === 0) return 'none';
  return n === keys.length ? 'all' : 'some';
}

export const toggleGroup = (selected, keys) => (triState(selected, keys) === 'all' ? selectNone(selected, keys) : selectAll(selected, keys));
