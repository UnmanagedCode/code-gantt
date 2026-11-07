import fs from 'node:fs/promises';

/**
 * Incremental JSONL reader. Reads bytes [offset, sizeAtOpen) and returns only complete
 * (newline-terminated) lines; a torn trailing line is left for the next pass.
 *
 * @param {string} file
 * @param {number} offset byte offset returned by the previous call (0 initially)
 * @param {{onOpen?: () => void}} [opts]
 *   onOpen: hook invoked right after the size is captured (lets tests grow the file mid-read).
 * @returns {Promise<{lines: {value: any, byteOffset: number}[], offset: number, corrupt: {byteOffset: number}[], missing: boolean, reset: boolean, size: number}>}
 */
export async function readFrom(file, offset, opts = {}) {
  const out = { lines: [], offset, corrupt: [], missing: false, reset: false, size: 0 };
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') {
      out.missing = true;
      return out;
    }
    throw err;
  }
  try {
    const { size } = await fh.stat();
    opts.onOpen?.();
    out.size = size;
    let start = offset;
    if (size < start) {
      out.reset = true;
      start = 0;
    }
    out.offset = start;
    const len = size - start;
    if (len <= 0) return out;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const lastNl = buf.lastIndexOf(0x0a, got - 1);
    if (lastNl < 0) return out;
    let pos = 0;
    while (pos <= lastNl) {
      const nl = buf.indexOf(0x0a, pos);
      const text = buf.toString('utf8', pos, nl);
      const byteOffset = start + pos;
      pos = nl + 1;
      if (text.trim() === '') continue;
      try {
        out.lines.push({ value: JSON.parse(text), byteOffset });
      } catch {
        out.corrupt.push({ byteOffset });
      }
    }
    out.offset = start + lastNl + 1;
    return out;
  } finally {
    await fh.close();
  }
}
