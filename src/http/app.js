import fs from 'node:fs';
import path from 'node:path';
import { buildPayload } from '../model/build.js';

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** URL path → absolute file, for every .html/.js/.css under publicDir. Nothing else is ever served. */
function staticAllowlist(publicDir) {
  const map = new Map();
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (TYPES[path.extname(e.name)]) map.set(rel, path.join(dir, e.name));
    }
  };
  walk(publicDir, '');
  if (map.has('/index.html')) map.set('/', map.get('/index.html'));
  return map;
}

function parseWindow(params) {
  const out = {};
  for (const k of ['from', 'to']) {
    if (!params.has(k)) continue;
    const v = Number(params.get(k));
    if (!Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out;
}

export function createApp({ state, live, publicDir, now = Date.now }) {
  const files = staticAllowlist(publicDir);

  return function handler(req, res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      if (p === '/api/health') return send(200, '{"ok":true}', 'application/json');
      if (p === '/api/gantt') {
        const win = parseWindow(url.searchParams);
        if (!win) return send(400, '{"error":"from/to must be epoch milliseconds"}', 'application/json');
        return send(200, JSON.stringify(buildPayload(state, { ...win, now: now() })), 'application/json');
      }
      if (p === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const write = (v) => res.write(`data: ${JSON.stringify({ version: v })}\n\n`);
        write(state.version);
        live.events.on('changed', write);
        res.on('close', () => live.events.off('changed', write));
        return undefined;
      }

      let decoded;
      try { decoded = decodeURIComponent(p); } catch { return send(404, 'Not found'); }
      const file = decoded === p || !decoded.includes('/..') ? files.get(decoded) : null;
      if (!file || decoded.includes('..') || decoded.includes('\0')) return send(404, 'Not found');
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      console.error('[code-gantt] request failed:', err);
      if (!res.headersSent) return send(500, 'Internal error');
      res.end();
      return undefined;
    }
  };
}
