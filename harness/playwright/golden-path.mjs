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

    // A forwarded send_prompt is a send_prompt link plus a forward link, shifted a fixed number of pixels.
    const forwards = payload.links.filter((l) => l.type === 'forward' && l.pair);
    assert.equal(forwards.length, 3, 'three forwarded calls');
    for (const f of forwards) {
      assert.ok(payload.links.some((l) => l.type === 'send_prompt' && l.ts === f.ts && l.to === f.to && JSON.stringify(l.pair) === JSON.stringify(f.pair)), 'forward has its send_prompt partner');
    }
    const pairDx = () => page.evaluate(() => {
      const end = (g) => { const c = g.querySelector('.link-end').getBoundingClientRect(); return { x: c.x + c.width / 2, y: c.y + c.height / 2 }; };
      const sps = [...document.querySelectorAll('.link-g[data-type="send_prompt"]')].map(end);
      return [...document.querySelectorAll('.link-g[data-type="forward"]')].filter((g) => g.querySelector('.link-end')).map(end).map((f) => {
        const sp = sps.find((p) => Math.abs(p.y - f.y) < 1 && Math.abs(p.x - f.x) < 5);
        return sp ? f.x - sp.x : null;
      });
    });
    const near = (dx) => assert.ok(dx != null && Math.abs(dx - 2) <= 0.5, `forward is ~2px right of its send_prompt (got ${dx})`);
    // the forward is solid (no dasharray), while heartbeat stays dashed
    const dash = (sel) => page.locator(sel).first().evaluate((n) => getComputedStyle(n).strokeDasharray);
    const fwDash = await dash('.link-g[data-type="forward"] .link');
    const hbDash = await dash('.link-g.heartbeat .link');
    assert.ok(['none', ''].includes(fwDash), `forward is solid (dasharray ${fwDash})`);
    assert.notEqual(hbDash, 'none', `heartbeat stays dashed (${hbDash})`);
    // a forward whose ends share a group is a line; one whose ends do not is two stubs. Each ends in a target dot beside its send_prompt's.
    const dx0 = await pairDx();
    assert.equal(dx0.length, 3, 'one forward line and two stub targets');
    dx0.forEach(near);
    const sameSide = forwards.find((f) => payload.sessions[f.from].title === 'Beta approx-end worker' && payload.sessions[f.to].title === 'Beta recent worker');
    assert.ok(sameSide, 'the same-side pair is in the payload');
    const sameSideSel = `.link-g[data-type="forward"][data-from="${sameSide.from}"][data-to="${sameSide.to}"]:not(.link-stub)`;
    const fwHit = page.locator(`${sameSideSel} .link-hit`);
    await fwHit.scrollIntoViewIfNeeded();
    const fb = await fwHit.boundingBox();
    // the same-side precondition: both lines start on the same side of their shared target end
    const sides = await page.evaluate((sel) => {
      const fg = document.querySelector(sel);
      const fe = fg.querySelector('.link-end').getBoundingClientRect();
      const spg = [...document.querySelectorAll('.link-g[data-type="send_prompt"]')].find((g) => {
        const e = g.querySelector('.link-end').getBoundingClientRect();
        return Math.abs(e.y - fe.y) < 1 && Math.abs(e.x - fe.x) < 5;
      });
      const ln = (g) => { const l = g.querySelector('.link'); return Math.sign(Number(l.getAttribute('y1')) - Number(l.getAttribute('y2'))); };
      return spg ? [ln(spg), ln(fg)] : null;
    }, sameSideSel);
    assert.ok(sides && sides[0] !== 0 && sides[0] === sides[1], `same-side pair: both lines start on one side of the target (${sides})`);
    // the forward hit is painted beneath its send_prompt: only its exposed right-hand crescent can be reached
    const crescent = { x: fb.x + fb.width - 0.5, y: fb.y + fb.height / 2 };
    const reached = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.link-g')?.getAttribute('data-type'), crescent);
    assert.equal(reached, 'forward', 'the forward hit target is reachable at its crescent');
    await page.mouse.move(crescent.x, crescent.y);
    await page.waitForSelector('g.tooltip');
    assert.equal((await page.locator('g.tooltip text').first().textContent()), 'forward', 'the tooltip is the forward line\'s');
    const tipText = await page.textContent('g.tooltip');
    for (const name of ['Conductor', 'Beta recent worker', 'Beta approx-end worker']) assert.ok(tipText.includes(name), `tooltip names ${name}`);
    await page.screenshot({ path: path.join(shots, '13-forward-pair-tooltip.png'), fullPage: true });
    // zoom in on the pair: the offset stays the same number of pixels
    const axisPre = await page.$eval('.axis', (n) => n.textContent);
    await page.mouse.move(crescent.x, crescent.y);
    await page.keyboard.down('Control');
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
    await page.keyboard.up('Control');
    await page.waitForFunction((b) => document.querySelector('.axis').textContent !== b, axisPre);
    const dxZ = await pairDx();
    assert.equal(dxZ.length, forwards.length, 'every rendered forward is measured after the zoom');
    dxZ.forEach(near);
    const fbZ = await fwHit.boundingBox();
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(shots, '13b-forward-pair.png'),
      clip: { x: Math.max(0, fbZ.x - 90), y: Math.max(0, fbZ.y - 110), width: 180, height: 160 } });
    await page.click('button[name="reset-zoom"]');

    // Section leads: Conductor band, one section per lead in project bands, links only inside a section, stubs across sections.
    const groupsOf = () => page.evaluate(() => {
      const bands = [...document.querySelectorAll('.project-label')].map((n) => ({ name: n.textContent, y: n.getBoundingClientRect().y }));
      const bars = [...document.querySelectorAll('.bar-g')].map((g) => ({ id: g.dataset.id, y: g.getBoundingClientRect().y }));
      return Object.fromEntries(bands.map((b, i) => [b.name, bars.filter((x) => x.y > b.y && x.y < (bands[i + 1]?.y ?? Infinity)).sort((p, q) => p.y - q.y).map((x) => x.id)]));
    });
    const groups = await groupsOf();
    assert.deepEqual(groups.Conductor, ['c0000004', '5ec00001', '5ec00002'], 'Conductor holds the conductor and its section leads');
    assert.ok(groups.alpha.includes('5ec00001') && groups.beta.includes('5ec00001'), 'the lead repeats as a header in each project it drives');
    assert.ok(groups.alpha.includes('e0000001') && groups.beta.includes('e0000002'));
    const rootRowCtx = await page.evaluate(() => {
      const label = [...document.querySelectorAll('.row-label')].find((n) => n.textContent === 'Leads conductor');
      return label?.classList.contains('context') && label.classList.contains('head');
    });
    assert.ok(rootRowCtx, 'the conductor header in Conductor is a dimmed copy, never home');
    const bandsOf = (from, to) => page.evaluate(([f, t]) => {
      const bands = [...document.querySelectorAll('.project-label')].map((n) => ({ name: n.textContent, y: n.getBoundingClientRect().y }));
      return [...document.querySelectorAll(`.link-g[data-type="send_prompt"][data-from="${f}"][data-to="${t}"]:not(.link-stub)`)].map((g) => {
        const y = g.querySelector('.link-end').getBoundingClientRect().y;
        return bands.filter((b) => b.y < y).at(-1)?.name;
      });
    }, [from, to]);
    assert.deepEqual(await bandsOf('c0000004', '5ec00001'), ['Conductor', 'alpha', 'beta'], 'root → lead is drawn in Conductor and in each project band the lead drives');
    assert.deepEqual(await bandsOf('c0000004', '5ec00002'), ['Conductor', 'alpha'], 'root → lead two is drawn in Conductor and in lead two’s own alpha section');
    assert.equal(await page.locator('.link-stub[data-from="c0000004"][data-to="5ec00002"]').count(), 0, '…and is not stubbed');
    const sectionTree = new Set(['c0000004', '5ec00001', '5ec00002', 'e0000001', 'e0000002', 'e0000003', 'e0000004', 'e0000005', 'e0000006', 'e0000007']);
    assert.deepEqual(groups.alpha.filter((id) => sectionTree.has(id)),
      ['c0000004', 'e0000003', 'e0000007', 'c0000004', '5ec00001', 'e0000001', 'e0000004', 'c0000004', '5ec00002', 'e0000005', 'e0000006'],
      'alpha: the conductor’s own section first, then one section per lead, each under its own conductor copy');
    const spans = await page.evaluate(() => {
      const bands = [...document.querySelectorAll('.project-label')].map((n) => ({ name: n.textContent, y: n.getBoundingClientRect().y }));
      return [...document.querySelectorAll('.link-g[data-type="send_prompt"][data-from="c0000004"]:not(.link-stub)')]
        .filter((g) => ['5ec00001', '5ec00002'].includes(g.dataset.to)).map((g) => {
          const l = g.querySelector('.link');
          const y = g.querySelector('.link-end').getBoundingClientRect().y;
          return { band: bands.filter((b) => b.y < y).at(-1)?.name, span: Math.abs(l.getAttribute('y2') - l.getAttribute('y1')) };
        });
    });
    const sectionLines = spans.filter((x) => x.band !== 'Conductor');
    assert.ok(sectionLines.length >= 3 && sectionLines.every((x) => x.span === 26), 'each root → lead line outside Conductor stays in its own section (one row)');
    const lineCount = (type, f, t) => page.locator(`.link-g[data-type="${type}"][data-from="${f}"][data-to="${t}"]:not(.link-stub)`).count();
    const stubCount = (type, f, t) => page.locator(`.link-g.link-stub[data-type="${type}"][data-from="${f}"][data-to="${t}"]`).count();
    assert.deepEqual([await lineCount('send_prompt', '5ec00002', 'e0000005'), await stubCount('send_prompt', '5ec00002', 'e0000005')], [1, 0], 'lead two → its worker is one line');
    assert.deepEqual([await lineCount('wake', 'e0000006', '5ec00002'), await stubCount('wake', 'e0000006', '5ec00002')], [1, 0], 'worker → lead two (wake) is one line');
    const stubSel = '.link-g.link-stub[data-type="forward"][data-from="e0000003"][data-to="5ec00002"]';
    assert.equal(await page.locator(stubSel).count(), 2, 'a forward from the conductor’s own worker to a lead crosses sections: two stubs, even though the lead has a section in the same band');
    assert.equal(await page.locator('.link-g[data-type="forward"][data-from="e0000003"]:not(.link-stub)').count(), 0, '…and no line');
    await page.screenshot({ path: path.join(shots, '14-section-leads.png'), fullPage: true });
    const ring = page.locator(`${stubSel}:not(:has(.link-end)) .link-hit`);
    await ring.scrollIntoViewIfNeeded();
    const rb = await ring.boundingBox();
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.waitForSelector('g.tooltip');
    const stubTip = await page.textContent('g.tooltip');
    assert.ok(stubTip.includes('Section lead two') && stubTip.includes('Conductor') && /not drawn here/.test(stubTip), `stub tooltip names the other end and its group (${stubTip})`);
    await page.screenshot({ path: path.join(shots, '14b-stub-tooltip.png'), fullPage: true });
    await page.mouse.move(5, 5);

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
    const scaleBox = await page.locator('svg.chart-scale').boundingBox();
    const before = await page.$eval('.axis', (n) => n.textContent);
    await page.mouse.move(svgBox.x + 700, svgBox.y + 200);
    await page.keyboard.down('Control');
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -200);
    await page.keyboard.up('Control');
    await page.waitForFunction((b) => document.querySelector('.axis').textContent !== b, before);
    await page.mouse.move(svgBox.x + 600, svgBox.y + 150);
    await page.mouse.down();
    await page.mouse.move(svgBox.x + 400, svgBox.y + 150, { steps: 5 });
    await page.mouse.up();
    await page.screenshot({ path: path.join(shots, '06-zoom-pan.png'), fullPage: true });
    await page.click('button[name="reset-zoom"]');

    // Brush on the time scale: a band while dragging, a zoomed axis after release.
    const axisBefore = await page.$eval('.axis', (n) => n.textContent);
    await page.mouse.move(scaleBox.x + 250 + 100, scaleBox.y + 15);
    await page.mouse.down();
    await page.mouse.move(scaleBox.x + 250 + 400, scaleBox.y + 15, { steps: 5 });
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
    // forward: one line plus two stub ends for each of the two pairs whose ends share no group
    assert.equal(await page.locator('.link-g[data-type="forward"]').count(), 5, 'hiding send_prompt leaves forward');
    assert.equal(await legendSend.getAttribute('aria-pressed'), 'false');
    await page.screenshot({ path: path.join(shots, '07b-legend-muted.png'), fullPage: true });
    await legendSend.click();
    assert.ok(await page.locator('.link-g[data-type="send_prompt"]').count() > 0);
    const countOf = (t) => page.locator(`.link-g[data-type="${t}"]`).count();
    const fwdBefore = await countOf('forward');
    const spBefore = await countOf('send_prompt');
    const legendFwd = page.locator('.legend-item[data-key="forward"]');
    await legendFwd.click();
    assert.equal(await countOf('forward'), 0);
    assert.equal(await countOf('send_prompt'), spBefore, 'hiding forward leaves send_prompt');
    await legendFwd.click();
    assert.equal(await countOf('forward'), fwdBefore);

    await page.click('button[name="filter:projects"]');
    await page.click('#fmenu-projects button[name="none"]');
    assert.equal(await page.locator('.empty-hint').isVisible(), true);
    await page.screenshot({ path: path.join(shots, '07c-empty-selection.png'), fullPage: true });
    await page.click('#fmenu-projects button[name="all"]');
    await page.click('h1');
    assert.equal(await page.locator('.empty-hint').count(), 0);

    // Conductors filter: first in the toolbar, narrows the Projects list.
    assert.deepEqual(await page.$$eval('.filter-row .fmenu-btn', (bs) => bs.map((b) => b.getAttribute('name'))), ['filter:roots', 'filter:projects', 'filter:links']);
    assert.match(await page.textContent('button[name="filter:roots"]'), /^\s*Conductors/);
    const listedProjects = () => page.$$eval('#fmenu-projects .fmenu-row', (rs) => rs.map((r) => r.getAttribute('data-key')));
    await page.click('button[name="filter:roots"]');
    await page.hover('#fmenu-roots .fmenu-row[data-key="c0000001"]');
    await page.click('#fmenu-roots .fmenu-row[data-key="c0000001"] button.only');
    await page.click('button[name="filter:projects"]');
    assert.deepEqual(await listedProjects(), ['alpha', 'beta']);
    assert.equal(await page.locator('.project-label', { hasText: 'delta' }).count(), 0);
    await page.screenshot({ path: path.join(shots, '07d-conductors-narrowed.png'), fullPage: true });
    await page.click('button[name="filter:roots"]');
    await page.click('#fmenu-roots button[name="none"]');
    await page.click('button[name="filter:projects"]');
    assert.equal((await listedProjects()).length, 0);
    assert.notEqual((await page.textContent('#fmenu-projects .fmenu-empty')).trim(), '');
    assert.equal(await page.locator('.empty-hint').isVisible(), true);
    await page.screenshot({ path: path.join(shots, '07e-conductors-none.png'), fullPage: true });
    await page.click('button[name="filter:roots"]');
    await page.click('#fmenu-roots button[name="all"]');
    await page.click('button[name="filter:projects"]');
    assert.ok((await listedProjects()).includes('delta'));
    await page.click('h1');
    assert.equal(await page.locator('.empty-hint').count(), 0);

    // Scrolled body: the rows scroll inside the chart while the chrome stays put.
    await page.setViewportSize({ width: 1500, height: 340 });
    // The resize handler re-renders the svgs; wait for it so no measurement races a svg swap.
    await page.waitForFunction(() => {
      const w = document.querySelector('svg.chart-scale')?.getAttribute('width');
      return w != null && Number(w) === document.querySelector('.chart-scroll').clientWidth;
    });
    const scrollInfo = () => page.$eval('.chart-scroll', (n) => ({ top: n.scrollTop, sh: n.scrollHeight, ch: n.clientHeight }));
    const info0 = await scrollInfo();
    assert.ok(info0.sh > info0.ch, 'fixture is tall enough to scroll the rows');
    const boxes = () => Promise.all(['.filters', '.legend-host', '.chart-scale-box', '#details'].map((s) => page.locator(s).boundingBox()));
    const boxesBefore = await boxes();
    const axisText = () => page.$eval('.axis', (n) => n.textContent);
    const axisBefore2 = await axisText();
    const rowsBox = await page.locator('.chart-scroll').boundingBox();
    await page.mouse.move(rowsBox.x + 700, rowsBox.y + 100);
    await page.mouse.wheel(0, 200);
    await page.waitForFunction(() => document.querySelector('.chart-scroll').scrollTop > 0);
    const page0 = await page.evaluate(() => ({ y: window.scrollY, sh: document.scrollingElement.scrollHeight, ih: window.innerHeight }));
    assert.equal(page0.y, 0, 'page does not scroll');
    assert.ok(page0.sh <= page0.ih, 'page has no overflow');
    assert.deepEqual(await boxes(), boxesBefore, 'chrome does not move');
    assert.equal(await axisText(), axisBefore2, 'plain wheel over rows does not zoom');
    const align = await page.evaluate(() => {
      const t = document.querySelector('.axis text').getBoundingClientRect();
      const x = document.querySelector('line.grid').getBoundingClientRect().x;
      return Math.abs(t.x + t.width / 2 - x);
    });
    assert.ok(align <= 1, 'tick and grid stay horizontally aligned');
    await page.screenshot({ path: path.join(shots, '09-scrolled.png'), fullPage: true });
    const topScrolled = (await scrollInfo()).top;
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -200);
    await page.keyboard.up('Control');
    await page.waitForFunction((b) => document.querySelector('.axis').textContent !== b, axisBefore2);
    assert.equal((await scrollInfo()).top, topScrolled, 'zoom keeps the scroll offset');
    await page.screenshot({ path: path.join(shots, '10-scrolled-zoomed.png'), fullPage: true });
    const sb = await page.locator('svg.chart-scale').boundingBox();
    const hostBox0 = await page.locator('.chart-host').boundingBox();
    await page.mouse.move(sb.x + 250 + 200, sb.y + 15);
    await page.waitForSelector('g.crosshair');
    const ch = await page.locator('g.crosshair line').boundingBox();
    assert.ok(Math.abs(ch.y - sb.y) <= 2, 'crosshair starts at the scale top');
    assert.ok(Math.abs(ch.y + ch.height - (hostBox0.y + hostBox0.height)) <= 4, 'crosshair spans the visible rows');
    const readoutText = await page.locator('g.crosshair text').textContent();
    assert.match(readoutText, /^\d\d-\d\d \d\d:\d\d(:\d\d)?$/, 'readout is a local date and time');
    const pill = await page.locator('g.crosshair-readout rect').boundingBox();
    assert.ok(pill.y >= sb.y && pill.y + pill.height <= sb.y + sb.height, 'readout sits inside the scale');
    await page.screenshot({ path: path.join(shots, '12-crosshair.png'), fullPage: true });
    await page.mouse.move(sb.x + sb.width - 10, sb.y + 15);
    const pillR = await page.locator('g.crosshair-readout rect').boundingBox();
    assert.ok(pillR.x + pillR.width <= sb.x + sb.width, 'readout flips instead of clipping at the right edge');
    await page.screenshot({ path: path.join(shots, '12b-crosshair-right-edge.png'), fullPage: true });
    await page.mouse.move(sb.x + 250 + 200, sb.y + sb.height + 40);
    assert.equal(await page.locator('g.crosshair').count(), 0, 'no crosshair over the rows');
    await page.mouse.move(sb.x + 250 + 100, sb.y + 15);
    await page.mouse.down();
    await page.mouse.move(sb.x + 250 + 300, sb.y + 15, { steps: 5 });
    const band = await page.locator('.brush-band').boundingBox();
    const hostBox = await page.locator('.chart-host').boundingBox();
    assert.equal(await page.locator('g.crosshair').count(), 1, 'crosshair and band coexist during the drag');
    assert.ok(Math.abs(band.y - sb.y) <= 2, 'band starts at the scale top');
    assert.ok(Math.abs(band.y + band.height - (hostBox.y + hostBox.height)) <= 4, 'band spans the visible rows');
    await page.screenshot({ path: path.join(shots, '11-scrolled-brush.png'), fullPage: true });
    const axisBrushBefore = await axisText();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(await page.locator('.brush-band').count(), 0, 'Escape aborts the brush');
    assert.equal(await axisText(), axisBrushBefore, 'aborted brush does not zoom');
    await page.click('button[name="reset-zoom"]');
    // data-id is not unique (a context ancestor renders once per project), so click by index among all bars.
    const detailsBefore = await page.textContent('#details');
    const pick = await page.evaluate((shownText) => {
      const r = document.querySelector('.chart-scroll').getBoundingClientRect();
      const bars = [...document.querySelectorAll('.bar-g')];
      const index = bars.findIndex((g) => {
        const b = g.getBoundingClientRect();
        return b.top >= r.top && b.bottom <= r.bottom && !new RegExp(`ID\\s*${g.getAttribute('data-id')}(?![0-9a-f])`).test(shownText);
      });
      return index < 0 ? null : { index, id: bars[index].getAttribute('data-id') };
    }, detailsBefore);
    assert.ok(pick, 'a visible bar other than the selected one exists in the scrolled rows');
    const topBeforeClick = (await scrollInfo()).top;
    await page.locator('.bar-g').nth(pick.index).click();
    const detailsAfter = await page.textContent('#details');
    assert.notEqual(detailsAfter, detailsBefore, 'details changed');
    assert.match(detailsAfter, new RegExp(`ID\\s*${pick.id}`), 'details show the clicked bar');
    assert.equal((await scrollInfo()).top, topBeforeClick, 'selecting keeps the scroll offset');
    await page.setViewportSize({ width: 1500, height: 900 });

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
