// End-to-end check of the Bikewatching page in headless Chromium.
// Local:  pnpm test:browser            (serves this folder on a free port)
// Live:   BASE_URL=https://arnavgoel03.github.io/bikewatching/ pnpm test:browser
// Writes screenshots to test-results/. Exits non-zero on any failed check.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'test-results');
const STATION_COUNT = 453;
const LOAD_TIMEOUT_MS = 60_000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.geojson': 'application/geo+json' };

// The committed map.js holds a placeholder; locally the token comes from
// MAPBOX_TOKEN or ~/.mapbox.key, the same file `save-key mapbox` writes.
async function localToken() {
  const token = (process.env.MAPBOX_TOKEN ?? (await readFile(join(homedir(), '.mapbox.key'), 'utf8'))).trim();
  if (!/^pk\.[\w.-]+$/.test(token)) throw new Error('No public pk. Mapbox token for the local run');
  return token;
}

function serve(token) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      let body = await readFile(file);
      if (file.endsWith('/map.js')) body = body.toString().replace('__MAPBOX_TOKEN__', token);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const circleState = (page) =>
  page.$$eval('#map svg circle', (cs) =>
    cs.map((c) => ({
      r: Number(c.getAttribute('r')),
      cx: Number(c.getAttribute('cx')),
      ratio: c.style.getPropertyValue('--departure-ratio').trim(),
      fill: getComputedStyle(c).fill,
      title: c.querySelector('title')?.textContent ?? '',
    })),
  );

async function setSlider(page, value) {
  await page.$eval(
    '#time-slider',
    (el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
}

let server;
let base = process.env.BASE_URL;
if (!base) {
  server = await serve(await localToken());
  base = `http://127.0.0.1:${server.address().port}/`;
}
await mkdir(OUT, { recursive: true });

// HEADLESS_PATH reuses an already-downloaded headless shell instead of
// fetching the one pinned to this Playwright version.
const browser = await chromium.launch(process.env.HEADLESS_PATH ? { executablePath: process.env.HEADLESS_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const laneResponses = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('response', (r) => {
    if (/geojson|Bike_Facilities|existing-bike-network/i.test(r.url())) laneResponses.push(r.status());
  });

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('html[data-ready="true"]', { timeout: LOAD_TIMEOUT_MS });
  // Wait until lanes, tiles and labels have all arrived before judging the render.
  await page.waitForLoadState('networkidle', { timeout: LOAD_TIMEOUT_MS });

  check('slider enabled once data loaded', await page.isEnabled('#time-slider'));
  check('favicon is the SVG bike', (await page.getAttribute('link[rel=icon]', 'href')) === 'assets/favicon.svg');
  check('map canvas rendered', (await page.locator('#map canvas.mapboxgl-canvas').count()) === 1);
  check('both bike-lane datasets fetched OK', laneResponses.length === 2 && laneResponses.every((s) => s === 200), laneResponses.join(','));

  let circles = await circleState(page);
  check('one circle per station', circles.length === STATION_COUNT, String(circles.length));
  check('circles sized by traffic (0 to 25)', Math.max(...circles.map((c) => c.r)) === 25 && circles.some((c) => c.r === 0));
  check('three flow colours in use', new Set(circles.map((c) => c.ratio)).size === 3, [...new Set(circles.map((c) => c.ratio))].join(','));
  check('every fill resolves to a colour', circles.every((c) => /^(rgb|oklch|color)/.test(c.fill)), circles[0].fill);
  check('tooltip format', circles.every((c) => /^\d+ trips \(\d+ departures, \d+ arrivals\)$/.test(c.title)), circles[0].title);
  check('busiest station first-drawn (small on top)', circles[0].r === 25);
  check('(any time) shown at -1', await page.isVisible('#any-time'));
  await page.screenshot({ path: join(OUT, 'desktop-any-time.png') });

  // Hover a mid-sized station: its native tooltip must be reachable.
  const target = await page.$$eval('#map svg circle', (cs) => {
    const c = cs.find((x) => Number(x.getAttribute('r')) > 8);
    const b = c.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, title: c.querySelector('title').textContent };
  });
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, target);
  check('circles receive pointer events', hit === 'circle', hit);

  // Pan: circles must follow the map.
  // Start the drag on bare map: a drag that starts on a circle goes to the SVG.
  const start = await page.evaluate(() => {
    for (let y = 300; y < 700; y += 7) {
      for (let x = 300; x < 1000; x += 7) {
        if (document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { x, y };
      }
    }
    return null;
  });
  const before = (await circleState(page))[0].cx;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 100, start.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(1200); // inertia settles
  const after = (await circleState(page))[0].cx;
  check('circles track a pan', after < before - 50, `${before} -> ${after}`);

  // Filter to 8:00 AM.
  await setSlider(page, 480);
  circles = await circleState(page);
  const timeText = (await page.textContent('#selected-time')).replace(/\s/g, ' ');
  check('time readout', timeText === '8:00 AM', timeText);
  check('aria-valuetext follows', (await page.getAttribute('#time-slider', 'aria-valuetext')).replace(/\s/g, ' ') === '8:00 AM');
  check('(any time) hidden when filtering', !(await page.isVisible('#any-time')));
  check('filtered radii use the 3 to 50 range', Math.min(...circles.map((c) => c.r)) === 3);
  const busiest = circles[0].title;
  check('8 AM busiest station matches reference', busiest === '921 trips (413 departures, 508 arrivals)', busiest);
  check('still one circle per station', circles.length === STATION_COUNT);
  await page.screenshot({ path: join(OUT, 'desktop-8am.png') });

  await setSlider(page, 1020);
  circles = await circleState(page);
  check('5 PM busiest station matches reference', circles[0].title === '2154 trips (1218 departures, 936 arrivals)', circles[0].title);
  await page.screenshot({ path: join(OUT, 'desktop-5pm.png') });

  await setSlider(page, 1440);
  check('slider max reads midnight', (await page.textContent('#selected-time')).replace(/\s/g, ' ') === '12:00 AM');

  await setSlider(page, -1);
  circles = await circleState(page);
  check('back to any time restores 0 to 25', Math.max(...circles.map((c) => c.r)) === 25 && (await page.isVisible('#any-time')));

  // Slider responsiveness: 50 input events must stay well under a frame budget each.
  const ms = await page.$eval('#time-slider', (el) => {
    const t0 = performance.now();
    for (let v = 300; v < 350; v++) {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return (performance.now() - t0) / 50;
  });
  check('slider update cost per input < 30 ms', ms < 30, `${ms.toFixed(1)} ms`);

  const legend = await page.$$eval('.legend > div', (ds) => ds.map((d) => [d.textContent.trim(), getComputedStyle(d, '::before').backgroundColor]));
  check('legend has three distinct swatches', legend.length === 3 && new Set(legend.map((l) => l[1])).size === 3, JSON.stringify(legend));

  check('no page or console errors', errors.length === 0, errors.join(' | '));

  // Phone width: no horizontal scroll, map still visible.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal scroll at 390 px', overflow <= 0, String(overflow));
  const mapBox = await page.locator('#map').boundingBox();
  check('map keeps real height on phone', mapBox.height > 300, String(mapBox.height));
  await page.screenshot({ path: join(OUT, 'phone.png'), fullPage: true });
} finally {
  await browser.close();
  server?.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nAll browser checks passed.');
