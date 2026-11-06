import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Maps backing session id → transcript path by listing `<root>/<encoded-cwd>/*.jsonl`.
 * cwd is never reconstructed: it is not stored per session and transcript `cwd` fields are unreliable.
 */
export async function buildBackingIndex(transcriptRoot) {
  const map = new Map();
  let dirs;
  try {
    dirs = await fs.readdir(transcriptRoot, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try {
      files = await fs.readdir(path.join(transcriptRoot, d.name));
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith('.jsonl')) map.set(f.slice(0, -'.jsonl'.length), path.join(transcriptRoot, d.name, f));
  }
  return map;
}
