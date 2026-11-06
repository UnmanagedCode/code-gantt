import fs from 'node:fs';
import path from 'node:path';

/**
 * The only module allowed to write to disk. Every write is confined to `dir`
 * (CONDUCTOR_PLUGIN_DATA_DIR); a path that resolves outside it throws.
 */
export function createDataDir(dir) {
  const base = path.resolve(dir);

  function realBase() {
    return fs.realpathSync(base);
  }

  function guard(rel) {
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`refusing path outside data dir: ${rel}`);
    // resolve symlinks on the deepest existing ancestor
    let probe = target;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    const rb = realBase();
    if (real !== rb && !real.startsWith(rb + path.sep)) throw new Error(`refusing path outside data dir (symlink): ${rel}`);
    return target;
  }

  return {
    dir: base,
    ensure() {
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      fs.chmodSync(base, 0o700);
    },
    writeJsonAtomic(rel, obj) {
      const target = guard(rel);
      const tmp = `${target}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
        fs.renameSync(tmp, target);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
    remove(rel) {
      fs.rmSync(guard(rel), { force: true });
    },
    readJson(rel) {
      try {
        return JSON.parse(fs.readFileSync(guard(rel), 'utf8'));
      } catch {
        return null;
      }
    },
  };
}
