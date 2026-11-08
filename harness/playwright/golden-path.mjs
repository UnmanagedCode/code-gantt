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
    await page.waitForSelector('svg.chart .link-g');
    await page.waitForFunction(() => !document.querySelector('.banner')?.textContent);
    await page.waitForTimeout(600); // let SSE-triggered reloads settle
    await page.screenshot({ path: path.join(shots, '01-load.png'), fullPage: true });

    // The horizon: the tree wholly before it is absent; bars spanning it start at it.
    const payload = await (await fetch(`${srv.url}/api/gantt`)).json();
    const horizon = Date.parse(payload.diagnostics.horizon);
    assert.equal(payload.window.from, horizon, 'window starts at the horizon');
    assert.equal(await page.locator('.bar-g[data-id="a0000006"]').count(), 0, 'pre-horizon tree absent');
    assert.equal(await page.locator('.project-label', { hasText: 'gamma' }).count(), 0, 'pre-horizon project absent');
    assert.equal(payload.sessions.a0000002.start, horizon);
    assert.ok(payload.links.every((l) => l.ts >= horizon), 'no link before the horizon');
    const x = async (id) => (await page.locator(`.bar-g[data-id="${id}"] .bar`).first().boundingBox()).x;
    assert.ok(Math.abs((await x('a0000002')) - (await x('a0000003'))) < 1.5, 'spanning bars start at the same x, the horizon');
    assert.match(await page.textContent('.diagnostics'), /history from/);

    await page.click('.bar-g[data-id="a0000002"] .bar');
    assert.match(await page.textContent('#details'), /Alpha implementer/);
    await page.screenshot({ path: path.join(shots, '02-details.png'), fullPage: true });

    await page.click('.bar-g[data-id="a0000003"] .bar');
    assert.match(await page.textContent('#details'), /State\s*killed/);
    assert.equal(await page.locator('.bar-g[data-id="a0000003"] .bar-killed').count() > 0, true);
    await page.screenshot({ path: path.join(shots, '02b-details-killed.png'), fullPage: true });

    await page.click('.bar-g[data-id="a0000004"] .bar');
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

    await page.click('button[name="filter:links"]');
    await page.fill('input[name="search:links"]', 'wake');
    await page.uncheck('input[name="link:wake"]');
    await page.uncheck('input[name="heartbeat"]');
    assert.equal(await page.locator('.link-g[data-type="wake"]').count(), 0);
    assert.equal(await page.isVisible('#fmenu-links'), true, 'popover stays open while toggling');
    await page.screenshot({ path: path.join(shots, '05-links-popover.png'), fullPage: true });
    await page.press('input[name="search:links"]', 'Escape');
    assert.equal(await page.isHidden('#fmenu-links'), true);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'filter:links');
    await page.click('button[name="filter:links"]');
    await page.fill('input[name="search:links"]', 'wake');
    await page.check('input[name="link:wake"]');
    await page.check('input[name="heartbeat"]');
    await page.click('h1');
    assert.equal(await page.isHidden('#fmenu-links'), true, 'click outside closes');

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

    // Brush on the time scale: a band while dragging, a zoomed axis after release.
    const axisBefore = await page.$eval('.axis', (n) => n.textContent);
    await page.mouse.move(svgBox.x + 250 + 100, svgBox.y + 15);
    await page.mouse.down();
    await page.mouse.move(svgBox.x + 250 + 400, svgBox.y + 15, { steps: 5 });
    assert.equal(await page.locator('.brush-band').count(), 1, 'band shown while dragging');
    await page.screenshot({ path: path.join(shots, '06b-brush-band.png'), fullPage: true });
    await page.mouse.up();
    await page.waitForFunction((b) => document.querySelector('.axis').textContent !== b, axisBefore);
    assert.equal(await page.locator('.brush-band').count(), 0, 'band removed after release');
    await page.screenshot({ path: path.join(shots, '06c-brush-zoomed.png'), fullPage: true });
    await page.click('button[name="reset-zoom"]');

    await page.click('button[name="filter:projects"]');
    await page.uncheck('input[name="project:beta"]');
    assert.equal(await page.locator('.project-label', { hasText: 'beta' }).count(), 0);
    await page.screenshot({ path: path.join(shots, '07-project-filter.png'), fullPage: true });
    await page.check('input[name="project:beta"]');
    await page.click('h1');
    assert.equal(await page.isHidden('#fmenu-projects'), true);

    const legendSend = page.locator('.legend-item[data-key="send_prompt"]');
    await legendSend.click();
    assert.equal(await page.locator('.link-g[data-type="send_prompt"]').count(), 0);
    assert.equal(await legendSend.getAttribute('aria-pressed'), 'false');
    await page.screenshot({ path: path.join(shots, '07b-legend-muted.png'), fullPage: true });
    await legendSend.click();
    assert.ok(await page.locator('.link-g[data-type="send_prompt"]').count() > 0);

    await page.click('button[name="filter:projects"]');
    await page.click('#fmenu-projects button[name="none"]');
    assert.equal(await page.locator('.empty-hint').isVisible(), true);
    await page.screenshot({ path: path.join(shots, '07c-empty-selection.png'), fullPage: true });
    await page.click('#fmenu-projects button[name="all"]');
    await page.click('h1');
    assert.equal(await page.locator('.empty-hint').count(), 0);

    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.click('button[name="filter:links"]');
    await page.screenshot({ path: path.join(shots, '08-dark.png'), fullPage: true });
  }, { headless: true, viewport: { width: 1500, height: 900 } });
} finally {
  await srv.close();
  store.cleanup();
}
const unexpected = errors.filter((e) => !/pluginBridge|pluginTheme|404/.test(e));
assert.deepEqual(unexpected, [], `console errors: ${unexpected.join('\n')}`);
console.log(`golden path OK; screenshots in ${shots}`);
