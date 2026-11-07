// Bikewatching: Bluebikes traffic in Boston and Cambridge, March 2024 (DSC 106 Lab 7).
// Both bare specifiers resolve through the import map in index.html.
import mapboxgl from 'mapbox-gl';
import * as d3 from 'd3';
import {
  ANY_TIME,
  bucketTrip,
  computeStationTraffic,
  createMinuteBuckets,
  departureRatio,
  formatTime,
  MINUTES_PER_DAY,
  parseTripTime,
  tooltipText,
  validateStations,
  validateTrips,
} from './traffic.js';

// Step 1.1: confirm Mapbox GL JS loaded.
console.log('Mapbox GL JS Loaded:', mapboxgl);

// Step 1.3: Mapbox public access token. It is never committed: the Pages
// deploy workflow replaces the placeholder from the MAPBOX_TOKEN repo secret,
// and tests/browser.mjs does the same locally from ~/.mapbox.key. A browser
// map must receive a public "pk." token, so restrict it to the site URL in
// the Mapbox dashboard.
const MAPBOX_TOKEN = '__MAPBOX_TOKEN__';

const MAP_OPTIONS = {
  container: 'map',
  // A light basemap keeps the bike lanes and station circles legible.
  style: 'mapbox://styles/mapbox/light-v11',
  center: [-71.09415, 42.36027], // [longitude, latitude], between MIT and Boston
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
};

// The bike-lane GeoJSON is served from this site: the Boston link goes
// through a slow ArcGIS redirect chain that drew its lanes seconds after the
// rest of the map. Unchanged copies (minified), downloaded 2026-11-07 from:
//   Boston:    https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson
//   Cambridge: https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson
const DATA_URLS = {
  bostonLanes: 'data/boston-bike-network-2022.geojson',
  cambridgeLanes: 'data/cambridge-bike-facilities.geojson',
  stations: 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json',
  trips: 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
};

// Step 5.3: circles grow when a time filter leaves fewer trips on screen.
const RADIUS_RANGE_ALL = [0, 25];
const RADIUS_RANGE_FILTERED = [3, 50];

// Mapbox cannot read CSS variables, so the lane colour is read once from the
// :root token in global.css, which stays its single source.
const laneColor = getComputedStyle(document.documentElement)
  .getPropertyValue('--color-bike-lane')
  .trim();

// Step 2.3: one paint object shared by the Boston and Cambridge layers.
const BIKE_LANE_PAINT = {
  'line-color': laneColor,
  'line-width': 3,
  'line-opacity': 0.5,
};

// Step 5.4: trips filed by start minute and by end minute.
const departuresByMinute = createMinuteBuckets();
const arrivalsByMinute = createMinuteBuckets();
const tripBuckets = { departuresByMinute, arrivalsByMinute };

// The station and trip files come from the course server. A transient error
// (a 503, a dropped connection) is retried with a growing pause before the
// load is given up, so one bad response does not leave the map empty.
const DATA_LOAD_ATTEMPTS = 3;
const DATA_RETRY_BASE_MS = 1500;
// A stalled download is abandoned after this long and retried. Generous: the
// trips file is about 6.5 MB compressed, about 50 s on a 1 Mbit/s link.
const DATA_TIMEOUT_MS = 90_000;

// One place that reports a load failure, with the owner-approved message in
// index.html. The slider stays disabled.
function showLoadError(error) {
  console.error('Bikewatching could not load:', error);
  document.getElementById('load-error').hidden = false;
}

async function withRetry(load, label) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      if (attempt >= DATA_LOAD_ATTEMPTS) throw error;
      console.warn(`Retrying ${label} (attempt ${attempt + 1} of ${DATA_LOAD_ATTEMPTS}):`, error);
      await new Promise((resolve) => setTimeout(resolve, DATA_RETRY_BASE_MS * attempt));
    }
  }
}

// Trips are bucketed while parsing, so every attempt starts from empty buckets;
// a retry after a partial parse can never double count.
async function loadTrips() {
  for (const bucket of [...departuresByMinute, ...arrivalsByMinute]) bucket.length = 0;
  const trips = await d3.csv(DATA_URLS.trips, { signal: AbortSignal.timeout(DATA_TIMEOUT_MS) }, (trip) => {
    trip.started_at = parseTripTime(trip.started_at);
    trip.ended_at = parseTripTime(trip.ended_at);
    bucketTrip(trip, departuresByMinute, arrivalsByMinute);
    return trip;
  });
  return validateTrips(trips);
}

async function loadStations() {
  return validateStations(await d3.json(DATA_URLS.stations, { signal: AbortSignal.timeout(DATA_TIMEOUT_MS) }));
}

mapboxgl.accessToken = MAPBOX_TOKEN;
// The constructor throws at once where WebGL is unavailable; report that like
// any other load failure. Every later use is guarded by `map?.`.
let map = null;
try {
  map = new mapboxgl.Map(MAP_OPTIONS);
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }));
} catch (error) {
  showLoadError(error);
}

// Step 3.3: project a station's longitude and latitude to map pixels. Handles
// pan, zoom and rotation.
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

// Map failures. Before 'load' (style or token rejected, e.g. a 401) the map
// can never draw, so report it. After 'load', a failed bike-lane file is
// retried like the data files and then reported; other errors (a single
// tile, say) are left to Mapbox, which recovers on its own.
const LANE_URLS = { boston_route: DATA_URLS.bostonLanes, cambridge_route: DATA_URLS.cambridgeLanes };
const laneAttempts = { boston_route: 1, cambridge_route: 1 };
let mapLoaded = false;

map?.on('error', (event) => {
  const laneUrl = LANE_URLS[event.sourceId];
  if (laneUrl) {
    const attempt = laneAttempts[event.sourceId];
    if (attempt >= DATA_LOAD_ATTEMPTS) {
      showLoadError(event.error);
      return;
    }
    laneAttempts[event.sourceId] = attempt + 1;
    console.warn(`Retrying ${event.sourceId} (attempt ${attempt + 1} of ${DATA_LOAD_ATTEMPTS}):`, event.error);
    setTimeout(() => map.getSource(event.sourceId)?.setData(laneUrl), DATA_RETRY_BASE_MS * attempt);
    return;
  }
  if (!mapLoaded) showLoadError(event.error);
});

// Everything after the map loads. Any throw in here, expected or not, is
// reported with the load-error message rather than leaving a half-built map.
async function setUpMap() {
  // Steps 2.1 to 2.3: bike lanes from both cities.
  map.addSource('boston_route', { type: 'geojson', data: DATA_URLS.bostonLanes });
  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: BIKE_LANE_PAINT,
  });

  map.addSource('cambridge_route', { type: 'geojson', data: DATA_URLS.cambridgeLanes });
  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: BIKE_LANE_PAINT,
  });

  // Steps 3.1 and 4.1: stations and trips, fetched in parallel. Trip times are
  // parsed and bucketed by minute as each row loads (Steps 5.3 and 5.4).
  let loadedStations;
  let trips;
  try {
    [loadedStations, trips] = await Promise.all([
      withRetry(loadStations, 'stations'),
      withRetry(loadTrips, 'trips'),
    ]);
  } catch (error) {
    // Every attempt failed: say so instead of leaving an empty map.
    showLoadError(error);
    return;
  }
  console.log('Loaded stations:', loadedStations.length);
  console.log('Loaded trips:', trips.length);

  // Step 4.2: traffic per station over the whole day.
  const stations = computeStationTraffic(loadedStations, ANY_TIME, tripBuckets);
  console.log('Stations Array:', stations);

  // Step 4.3: area, not radius, encodes traffic.
  // The top of the domain is at least 1: with no trips at all, [0, 0] would
  // make D3 draw every station at mid-size instead of zero.
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, Math.max(1, d3.max(stations, (d) => d.totalTraffic) ?? 0)])
    .range(RADIUS_RANGE_ALL);

  // Steps 3.3, 4.3, 4.4 and 6.1: one circle per station, keyed by short_name.
  const svg = d3.select('#map').select('svg');
  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', departureRatio)
    .each(function (d) {
      d3.select(this).append('title').text(tooltipText(d));
    });

  // Step 4.4, gone further: an on-page tooltip that appears instantly and
  // follows the pointer. The native <title> pops up only after a delay and is
  // often missing from screen recordings. Each circle keeps its <title> (the
  // lab's tooltip, and an accessible name); it is blanked only while that
  // circle is hovered, so the two never show at once.
  const tooltip = document.getElementById('tooltip');
  const TOOLTIP_OFFSET_PX = 14;
  let hovered = null;
  let lastPointer = null;

  function placeTooltip(event) {
    lastPointer = event;
    const { innerWidth, innerHeight } = window;
    const { width, height } = tooltip.getBoundingClientRect();
    // Flip to the other side of the pointer near the right or bottom edge.
    const x = event.clientX + TOOLTIP_OFFSET_PX + width > innerWidth
      ? event.clientX - TOOLTIP_OFFSET_PX - width
      : event.clientX + TOOLTIP_OFFSET_PX;
    const y = event.clientY + TOOLTIP_OFFSET_PX + height > innerHeight
      ? event.clientY - TOOLTIP_OFFSET_PX - height
      : event.clientY + TOOLTIP_OFFSET_PX;
    tooltip.style.left = `${Math.max(0, x)}px`;
    tooltip.style.top = `${Math.max(0, y)}px`;
  }

  // The circle whose tooltip is open, and whether its <title> was blanked
  // (pointer hover only; a focused circle keeps its <title> as its name for
  // screen readers, and browsers show no native tooltip on focus).
  let titleBlanked = false;

  function hideTooltip() {
    if (!hovered) return;
    hovered.querySelector('title').textContent = tooltipText(d3.select(hovered).datum());
    hovered = null;
    titleBlanked = false;
    tooltip.hidden = true;
  }

  function showTooltip(circle, point, { blankTitle }) {
    if (hovered !== circle) hideTooltip();
    hovered = circle;
    titleBlanked = blankTitle;
    // Set the <title> both ways: focusing a circle that is also under the
    // pointer must give it back its accessible name.
    circle.querySelector('title').textContent = blankTitle ? '' : tooltipText(d3.select(circle).datum());
    tooltip.textContent = tooltipText(d3.select(circle).datum());
    tooltip.hidden = false;
    placeTooltip(point);
  }

  // Pan a keyboard-focused station into view if it sits outside the map.
  function revealStation(circle) {
    const box = circle.getBoundingClientRect();
    const frame = map.getContainer().getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    if (cx < frame.left || cx > frame.right || cy < frame.top || cy > frame.bottom) {
      const d = d3.select(circle).datum();
      map.panTo([+d.lon, +d.lat], { duration: 0 });
    }
  }

  function centerOf(circle) {
    const box = circle.getBoundingClientRect();
    return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
  }

  circles
    .on('pointerenter', function (event) {
      showTooltip(this, event, { blankTitle: true });
    })
    .on('pointermove', placeTooltip)
    .on('pointerleave', (event) => {
      // A tap ends with pointerleave; keep its tooltip until the next tap elsewhere.
      if (event.pointerType !== 'touch') hideTooltip();
    });

  // Touch: a tap on anything that is not a station closes the open tooltip.
  document.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch' && !event.target.closest?.('#map circle')) hideTooltip();
  });

  // Keyboard: the stations are one Tab stop (roving tabindex). Arrow keys step
  // through them busiest first, Home and End jump to the ends, Escape closes
  // the tooltip. A focused station shows the same tooltip at its centre.
  const STATION_KEYS = {
    ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last',
  };
  circles.attr('tabindex', -1);

  circles
    .on('focus', function () {
      revealStation(this);
      showTooltip(this, centerOf(this), { blankTitle: false });
    })
    .on('blur', function () {
      if (hovered === this) hideTooltip();
    })
    .on('keydown', function (event) {
      if (event.key === 'Escape') {
        hideTooltip();
        return;
      }
      const step = STATION_KEYS[event.key];
      if (step === undefined) return;
      event.preventDefault();
      // Only stations drawn with some size: a zero-radius circle has no trips
      // at this time and nothing visible to focus.
      const ordered = [...this.parentNode.querySelectorAll('circle')].filter(
        (c) => c === this || Number(c.getAttribute('r')) > 0,
      );
      const index = ordered.indexOf(this);
      const nextIndex = step === 'first' ? 0
        : step === 'last' ? ordered.length - 1
        : (index + step + ordered.length) % ordered.length;
      const next = ordered[nextIndex];
      this.setAttribute('tabindex', -1);
      next.setAttribute('tabindex', 0);
      next.focus();
    });

  // Big circles first, so small stations stay on top and can be hovered.
  function sortBySize() {
    circles.sort((a, b) => d3.descending(a.totalTraffic, b.totalTraffic));
  }
  sortBySize();
  // The Tab stop starts on the busiest station, first after sorting.
  svg.select('circle').attr('tabindex', 0);

  // Step 3.3: keep circles aligned with the map.
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
    // A focused station's tooltip follows it as the map moves.
    if (hovered && hovered === document.activeElement) placeTooltip(centerOf(hovered));
  }
  updatePositions();
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // Step 5.2: slider and its readouts.
  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  // Step 5.3: recompute traffic for the selected time and resize, recolour
  // and re-label every circle.
  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter, tripBuckets);

    radiusScale.range(timeFilter === ANY_TIME ? RADIUS_RANGE_ALL : RADIUS_RANGE_FILTERED);

    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', departureRatio)
      .select('title')
      .text((d) => tooltipText(d));

    // Keep an open tooltip in step when the time changes under the pointer.
    if (hovered) {
      if (titleBlanked) hovered.querySelector('title').textContent = '';
      tooltip.textContent = tooltipText(d3.select(hovered).datum());
      // New text can change the box size, so re-place it at the pointer.
      if (lastPointer) placeTooltip(lastPointer);
    }

    sortBySize();
  }

  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);

    if (timeFilter === ANY_TIME) {
      selectedTime.textContent = '';
      selectedTime.removeAttribute('datetime');
      anyTimeLabel.style.display = 'block';
      timeSlider.setAttribute('aria-valuetext', anyTimeLabel.textContent);
    } else {
      const label = formatTime(timeFilter);
      selectedTime.textContent = label;
      selectedTime.setAttribute('datetime', toTimeAttribute(timeFilter));
      anyTimeLabel.style.display = 'none';
      timeSlider.setAttribute('aria-valuetext', label);
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
  // Disabled in the HTML so it cannot be dragged before the data exists; a
  // failed load above returns early and leaves it disabled.
  timeSlider.disabled = false;
  document.documentElement.dataset.ready = 'true';
}

map?.on('load', () => {
  mapLoaded = true;
  setUpMap().catch(showLoadError);
});

// Machine-readable value for <time datetime>, e.g. "08:30". 1440 is midnight.
function toTimeAttribute(minutes) {
  const wrapped = minutes % MINUTES_PER_DAY;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}
