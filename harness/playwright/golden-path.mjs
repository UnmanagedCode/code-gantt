// Golden-path visual check on a synthetic store. Screenshots land in harness/playwright/screenshots/ (gitignored).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';
import { buildFixture } from './fixture-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const { bootServer, withPage } = await import(BROWSER);

const store = buildFixture();
const srv = await bootServer({
  cwd: repoRoot,
  entry: 'server.js',
  env: {
    PROJECTS_ROOT: store.projectsRoot,
    CLAUDE_PROJECTS_ROOT: store.transcriptRoot,
    CONDUCTOR_PLUGIN_DATA_DIR: store.dataDir,
    CONDUCTOR_URL: '',
  },
});
const errors = [];
try {
  await withPage(async (page) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(srv.url);
    await page.waitForSelector('svg.chart');
    await page.waitForFunction(() => !document.querySelector('.banner')?.textContent);
    await page.reload(); // pick up the finished backfill
    await page.waitForSelector('svg.chart .link-g[data-type="wake"]');
    await page.screenshot({ path: path.join(shots, '01-load.png'), fullPage: true });

    await page.click('.bar-g[data-id="wkr00002"] .bar');
    assert.match(await page.textContent('#details'), /Alpha implementer/);
    await page.screenshot({ path: path.join(shots, '02-details.png'), fullPage: true });

    await page.click('.bar-g[data-id="wkr00004"] .bar');
    assert.match(await page.textContent('#details'), /approximate end/);
    await page.screenshot({ path: path.join(shots, '03-details-approx.png'), fullPage: true });

    const hit = page.locator('.link-g[data-type="send_prompt"] .link-hit').first();
    await hit.scrollIntoViewIfNeeded();
    const box = await hit.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('g.tooltip');
    await page.screenshot({ path: path.join(shots, '04-link-tooltip.png'), fullPage: true });

    const types = new Set(await page.$$eval('.link-g', (n) => n.map((x) => x.dataset.type)));
    for (const t of ['spawn', 'send_prompt', 'forward', 'wake', 'kill_instance', 'other']) assert.ok(types.has(t), `link type ${t} drawn`);
    assert.equal(await page.locator('.link-g[data-source="backfill"]').count() > 0, true);

    await page.uncheck('input[name="link:wake"]');
    await page.uncheck('input[name="heartbeat"]');
    assert.equal(await page.locator('.link-g[data-type="wake"]').count(), 0);
    await page.screenshot({ path: path.join(shots, '05-wake-off.png'), fullPage: true });
    await page.check('input[name="link:wake"]');
    await page.check('input[name="heartbeat"]');

    const svgBox = await page.locator('svg.chart').boundingBox();
    const before = await page.$eval('.axis', (n) => n.textContent);
    await page.mouse.move(svgBox.x + 700, svgBox.y + 200);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -200);
    await page.waitForFunction((b) => document.querySelector('.axis').textContent !== b, before);
    await page.mouse.move(svgBox.x + 600, svgBox.y + 150);
    await page.mouse.down();
    await page.mouse.move(svgBox.x + 400, svgBox.y + 150, { steps: 5 });
    await page.mouse.up();
    await page.screenshot({ path: path.join(shots, '06-zoom-pan.png'), fullPage: true });
    await page.click('button[name="reset-zoom"]');

    await page.uncheck('input[name="project:beta"]');
    assert.equal(await page.locator('.project-label', { hasText: 'beta' }).count(), 0);
    await page.screenshot({ path: path.join(shots, '07-project-filter.png'), fullPage: true });
    await page.check('input[name="project:beta"]');

    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ path: path.join(shots, '08-dark.png'), fullPage: true });
  }, { headless: true, viewport: { width: 1500, height: 900 } });
} finally {
  await srv.close();
  store.cleanup();
}
const unexpected = errors.filter((e) => !/pluginBridge|pluginTheme|404/.test(e));
assert.deepEqual(unexpected, [], `console errors: ${unexpected.join('\n')}`);
console.log(`golden path OK; screenshots in ${shots}`);
