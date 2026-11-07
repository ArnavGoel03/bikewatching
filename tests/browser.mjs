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
  check('no load-error message on a good load', await page.isHidden('#load-error'));
  await page.screenshot({ path: join(OUT, 'desktop-any-time.png') });

  // Hover a mid-sized station: its native tooltip must be reachable.
  const target = await page.$$eval('#map svg circle', (cs) => {
    const c = cs.find((x) => Number(x.getAttribute('r')) > 8);
    const b = c.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, title: c.querySelector('title').textContent };
  });
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, target);
  check('circles receive pointer events', hit === 'circle', hit);

  // Real hover: the on-page tooltip shows at once with the station's numbers,
  // the native <title> is blanked meanwhile, and both reset on leave.
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(100);
  const shown = await page.evaluate(() => {
    const t = document.getElementById('tooltip');
    const r = t.getBoundingClientRect();
    return { hidden: t.hidden, text: t.textContent, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  });
  check('tooltip appears on hover with the station numbers', !shown.hidden && shown.text === target.title, shown.text);
  check('tooltip stays inside the viewport', shown.inView);
  await page.screenshot({ path: join(OUT, 'desktop-hover.png'), clip: { x: Math.max(0, target.x - 200), y: Math.max(0, target.y - 120), width: 480, height: 240 } });
  const blanked = await page.$$eval('#map svg circle title', (ts) => ts.filter((t) => t.textContent === '').length);
  check('native title blanked only for the hovered circle', blanked === 1, String(blanked));
  await setSlider(page, 480);
  const live = await page.evaluate(() => document.getElementById('tooltip').textContent);
  check('open tooltip follows the slider', live !== target.title && /^\d+ trips/.test(live), live);
  await setSlider(page, -1);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(100);
  const left = await page.evaluate(() => ({
    hidden: document.getElementById('tooltip').hidden,
    blank: [...document.querySelectorAll('#map svg circle title')].filter((t) => t.textContent === '').length,
  }));
  check('tooltip hides and titles restore on leave', left.hidden && left.blank === 0, JSON.stringify(left));

  // Keyboard: Tab from the slider lands on the busiest station and opens its
  // tooltip; arrows move to the next station; Escape closes; the stations are
  // one Tab stop, and every <title> keeps its text throughout.
  await page.focus('#time-slider');
  await page.keyboard.press('Tab');
  const kb1 = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    title: document.activeElement.querySelector('title')?.textContent,
    tip: document.getElementById('tooltip').hidden ? null : document.getElementById('tooltip').textContent,
    stops: document.querySelectorAll('#map svg circle[tabindex="0"]').length,
  }));
  check('Tab reaches the busiest station and shows its tooltip', kb1.tag === 'circle' && kb1.tip === kb1.title && kb1.title === '11174 trips (5614 departures, 5560 arrivals)' && kb1.stops === 1, JSON.stringify(kb1));
  await page.keyboard.press('ArrowRight');
  const kb2 = await page.evaluate(() => ({
    title: document.activeElement.querySelector('title')?.textContent,
    tip: document.getElementById('tooltip').textContent,
    stops: document.querySelectorAll('#map svg circle[tabindex="0"]').length,
    blank: [...document.querySelectorAll('#map svg circle title')].filter((t) => t.textContent === '').length,
  }));
  check('arrow key moves to the next station', kb2.tip === kb2.title && kb2.title !== kb1.title && kb2.stops === 1 && kb2.blank === 0, JSON.stringify(kb2));
  await page.keyboard.press('Escape');
  check('Escape closes the station tooltip', await page.isHidden('#tooltip'));

  // Every station the arrow keys reach is drawn (radius > 0) and inside the map.
  await page.keyboard.press('Home');
  let unseen = 0;
  let zero = 0;
  for (let i = 0; i < 120; i += 1) {
    await page.keyboard.press('ArrowRight');
    const where = await page.evaluate(() => {
      const c = document.activeElement;
      const b = c.getBoundingClientRect();
      const f = document.getElementById('map').getBoundingClientRect();
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      return { r: Number(c.getAttribute('r')), inside: x >= f.left && x <= f.right && y >= f.top && y <= f.bottom };
    });
    if (!where.inside) unseen += 1;
    if (where.r === 0) zero += 1;
  }
  await page.keyboard.press('End');
  const endR = await page.evaluate(() => Number(document.activeElement.getAttribute('r')));
  check('arrow keys only visit visible stations inside the map', unseen === 0 && zero === 0 && endR > 0, `${unseen} outside, ${zero} zero-size, End r=${endR}`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement.blur());
  // Reset the view for the checks that follow.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('html[data-ready="true"]', { timeout: LOAD_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: LOAD_TIMEOUT_MS });

  // Hovering a station and then Tabbing onto the same station must leave its
  // <title> (its accessible name) filled in.
  const topStation = await page.$eval('#map svg circle', (c) => {
    const b = c.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(topStation.x, topStation.y);
  await page.focus('#time-slider');
  await page.keyboard.press('Tab');
  const mixed = await page.evaluate(() => document.activeElement.querySelector('title')?.textContent);
  check('hover then Tab to the same station keeps its name', mixed === '11174 trips (5614 departures, 5560 arrivals)', mixed);
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Tab');
  const kb3 = await page.evaluate(() => ({ tag: document.activeElement.tagName, hidden: document.getElementById('tooltip').hidden }));
  check('next Tab leaves the stations', kb3.tag !== 'circle' && kb3.hidden, JSON.stringify(kb3));
  await page.evaluate(() => document.activeElement.blur());

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

  // Touch: a tap on a station keeps its tooltip open; a tap on bare map closes
  // it and restores every <title>.
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const touch = await touchContext.newPage();
  await touch.goto(base, { waitUntil: 'domcontentloaded' });
  await touch.waitForSelector('html[data-ready="true"]', { timeout: LOAD_TIMEOUT_MS });
  const spots = await touch.evaluate(() => {
    const inView = (b) => b.left > 10 && b.right < innerWidth - 10 && b.top > 0 && b.bottom < innerHeight;
    const c = [...document.querySelectorAll('#map svg circle')].find((x) => Number(x.getAttribute('r')) > 6 && inView(x.getBoundingClientRect()));
    const b = c.getBoundingClientRect();
    let bare = null;
    for (let y = innerHeight - 60; y > 0 && !bare; y -= 9) {
      for (let x = 20; x < innerWidth - 20; x += 9) {
        if (document.elementFromPoint(x, y)?.tagName === 'CANVAS') { bare = { x, y }; break; }
      }
    }
    return { station: { x: b.x + b.width / 2, y: b.y + b.height / 2, title: c.querySelector('title').textContent }, bare };
  });
  await touch.touchscreen.tap(spots.station.x, spots.station.y);
  await touch.waitForTimeout(200);
  const tapped = await touch.evaluate(() => ({ hidden: document.getElementById('tooltip').hidden, text: document.getElementById('tooltip').textContent }));
  check('tap on a station shows its tooltip', !tapped.hidden && tapped.text === spots.station.title, JSON.stringify(tapped));
  await touch.touchscreen.tap(spots.bare.x, spots.bare.y);
  await touch.waitForTimeout(200);
  const closed = await touch.evaluate(() => ({
    hidden: document.getElementById('tooltip').hidden,
    blank: [...document.querySelectorAll('#map svg circle title')].filter((t) => t.textContent === '').length,
  }));
  check('tap on bare map closes it and restores titles', closed.hidden && closed.blank === 0, JSON.stringify(closed));
  await touchContext.close();

  // A transient failure of the course server is retried: the first trips
  // request returns 503 and the map must still fill with the right numbers.
  const flaky = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let tripRequests = 0;
  await flaky.route('**/bluebikes-traffic-2024-03.csv', (route) => {
    tripRequests += 1;
    return tripRequests === 1 ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue();
  });
  await flaky.goto(base, { waitUntil: 'domcontentloaded' });
  await flaky.waitForSelector('html[data-ready="true"]', { timeout: LOAD_TIMEOUT_MS });
  const flakyBusiest = await flaky.$eval('#map svg circle title', (t) => t.textContent);
  check('a 503 on the trips file is retried', tripRequests === 2 && flakyBusiest === '11174 trips (5614 departures, 5560 arrivals)', `${tripRequests} requests, ${flakyBusiest}`);
  check('no load-error message after a recovered 503', await flaky.isHidden('#load-error'));
  await flaky.close();

  // A lasting outage: every trips request fails. The page must say so and keep
  // the slider disabled instead of showing an empty map silently.
  const down = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let downRequests = 0;
  await down.route('**/bluebikes-traffic-2024-03.csv', (route) => {
    downRequests += 1;
    return route.fulfill({ status: 503, body: 'unavailable' });
  });
  await down.goto(base, { waitUntil: 'domcontentloaded' });
  await down.waitForSelector('#load-error:not([hidden])', { timeout: LOAD_TIMEOUT_MS });
  const downState = await down.evaluate(() => ({
    text: document.getElementById('load-error').textContent,
    slider: document.getElementById('time-slider').disabled,
    circles: document.querySelectorAll('#map svg circle').length,
  }));
  check('lasting outage shows the load error', downRequests === 3 && downState.slider && downState.circles === 0 && downState.text.startsWith("Couldn't load"), `${downRequests} requests, ${JSON.stringify(downState)}`);
  await down.screenshot({ path: join(OUT, 'load-error.png') });
  await down.close();

  // A 200 with the wrong body must be treated like a failed download, not
  // drawn as a map of zeros.
  const badBodies = [
    ['empty trips file', '**/bluebikes-traffic-2024-03.csv', '', 'text/csv'],
    ['HTML instead of trips CSV', '**/bluebikes-traffic-2024-03.csv', '<!DOCTYPE html><html><body>Service unavailable</body></html>', 'text/html'],
    ['stations JSON without stations', '**/bluebikes-stations.json', '{}', 'application/json'],
    ['a station with null coordinates', '**/bluebikes-stations.json', JSON.stringify({ data: { stations: [{ short_name: 'A1', lon: null, lat: null }] } }), 'application/json'],
    ['a station at latitude 91', '**/bluebikes-stations.json', JSON.stringify({ data: { stations: [{ short_name: 'A1', lon: -71.1, lat: 91 }] } }), 'application/json'],
  ];
  // Failures outside the data files: a CDN module, the Mapbox style (token
  // rejected), a bike-lane file that never comes back.
  const failures = [
    ['D3 module from the CDN fails', '**/d3@7.9.0/+esm', (route) => route.abort()],
    ['Mapbox style rejected (401)', 'https://api.mapbox.com/styles/v1/**', (route) => route.fulfill({ status: 401, body: '{"message":"Not Authorized"}', contentType: 'application/json' })],
    ['Boston lanes always 503', '**/boston-bike-network-2022.geojson', (route) => route.fulfill({ status: 503, body: 'unavailable' })],
  ];
  for (const [name, pattern, handler] of failures) {
    const failing = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await failing.route(pattern, handler);
    await failing.goto(base, { waitUntil: 'domcontentloaded' });
    const shown = await failing.waitForSelector('#load-error:not([hidden])', { timeout: LOAD_TIMEOUT_MS }).then(() => true, () => false);
    check(`${name}: load error shown`, shown);
    await failing.close();
  }

  // No WebGL: the Mapbox constructor throws at once; the page must say so.
  const noGl = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await noGl.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/i.test(type) ? null : original.call(this, type, ...rest);
    };
  });
  const noGlErrors = [];
  noGl.on('pageerror', (e) => noGlErrors.push(String(e)));
  await noGl.goto(base, { waitUntil: 'domcontentloaded' });
  const noGlShown = await noGl.waitForSelector('#load-error:not([hidden])', { timeout: LOAD_TIMEOUT_MS }).then(() => true, () => false);
  check('no WebGL: load error shown, no uncaught error', noGlShown && noGlErrors.length === 0, noGlErrors.join(' | '));
  await noGl.close();

  // One failed lane response is retried and the lanes still arrive.
  const laneRetry = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let bostonRequests = 0;
  await laneRetry.route('**/boston-bike-network-2022.geojson', (route) => {
    bostonRequests += 1;
    return bostonRequests === 1 ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue();
  });
  await laneRetry.goto(base, { waitUntil: 'domcontentloaded' });
  await laneRetry.waitForSelector('html[data-ready="true"]', { timeout: LOAD_TIMEOUT_MS });
  await laneRetry.waitForTimeout(4000);
  check('a 503 on a lane file is retried', bostonRequests === 2 && (await laneRetry.isHidden('#load-error')), `${bostonRequests} requests`);
  await laneRetry.close();

  for (const [name, pattern, body, contentType] of badBodies) {
    const bad = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const badErrors = [];
    bad.on('pageerror', (e) => badErrors.push(String(e)));
    await bad.route(pattern, (route) => route.fulfill({ status: 200, body, contentType }));
    await bad.goto(base, { waitUntil: 'domcontentloaded' });
    await bad.waitForSelector('#load-error:not([hidden])', { timeout: LOAD_TIMEOUT_MS });
    const state = await bad.evaluate(() => ({
      slider: document.getElementById('time-slider').disabled,
      circles: document.querySelectorAll('#map svg circle').length,
      ready: document.documentElement.dataset.ready ?? null,
    }));
    check(`200 with ${name} shows the load error`, state.slider && state.circles === 0 && state.ready === null && badErrors.length === 0, JSON.stringify({ ...state, badErrors }));
    await bad.close();
  }

  // Smallest phone with 200% text: an open tooltip must wrap and stay on screen.
  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('map').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  const small = await page.$$eval('#map svg circle', (cs) => {
    const c = cs.find((x) => {
      const b = x.getBoundingClientRect();
      return Number(x.getAttribute('r')) > 4 && b.left > 40 && b.right < innerWidth - 40 && b.top > 0 && b.bottom < innerHeight;
    });
    const b = c.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(small.x, small.y);
  await page.waitForTimeout(150);
  const fit = await page.evaluate(() => {
    const r = document.getElementById('tooltip').getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, vw: innerWidth, hidden: document.getElementById('tooltip').hidden, scroll: document.documentElement.scrollWidth - innerWidth };
  });
  check('tooltip fits a 320 px screen at 200% text', !fit.hidden && fit.left >= 0 && fit.right <= fit.vw && fit.scroll <= 0, JSON.stringify(fit));
  await page.mouse.move(2, 2);
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });

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
