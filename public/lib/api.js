// All URLs are relative to the page, so the plugin works behind cc's path-prefixed proxy.

function relative(path) {
  if (path.startsWith('/')) throw new Error(`api: root-relative URL not allowed: ${path}`);
  return path;
}

export async function getJson(path, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(relative(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** Calls onVersion(n) for every SSE `data: {"version":n}`. Returns a close function. */
export function subscribe(path, onVersion, EventSourceImpl = globalThis.EventSource) {
  const es = new EventSourceImpl(relative(path));
  es.onmessage = (e) => {
    try { onVersion(JSON.parse(e.data).version); } catch { /* ignore malformed */ }
  };
  return () => es.close();
}
