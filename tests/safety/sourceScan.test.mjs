import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
function walk(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(root, p);

test('no module in src/ or server.js uses an fs write API', () => {
  const files = [...walk(path.join(root, 'src'), ['.js']), path.join(root, 'server.js')].filter((f) => fs.existsSync(f));
  assert.ok(files.length > 1);
  const re = /\b(writeFile\w*|appendFile\w*|rename\w*|mkdir\w*|rm|rmSync|unlink\w*|createWriteStream|copyFile\w*|truncate\w*)\s*\(/;
  const offenders = files
    .filter((f) => re.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(offenders, []);
});

test('public/ has no HTML-injection sinks', () => {
  const files = walk(path.join(root, 'public'), ['.js', '.html']);
  assert.ok(files.length > 0);
  const re = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|srcdoc|\.style\.cssText|setAttribute\(\s*['"]on/;
  assert.deepEqual(files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map(rel), []);
});

test('public/ scripts use no root-relative URL literals', () => {
  const files = walk(path.join(root, 'public'), ['.js']);
  const re = /fetch\(\s*['"`]\/|EventSource\(\s*['"`]\/|['"`]\/api/;
  assert.deepEqual(files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map(rel), []);
});

test('index.html has exactly the two allowed root-relative URLs', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const urls = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(urls, ['/pluginBridge.js', '/pluginTheme.css']);
});
