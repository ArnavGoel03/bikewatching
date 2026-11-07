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
function loadTrips() {
  for (const bucket of [...departuresByMinute, ...arrivalsByMinute]) bucket.length = 0;
  return d3.csv(DATA_URLS.trips, (trip) => {
    trip.started_at = parseTripTime(trip.started_at);
    trip.ended_at = parseTripTime(trip.ended_at);
    bucketTrip(trip, departuresByMinute, arrivalsByMinute);
    return trip;
  });
}

mapboxgl.accessToken = MAPBOX_TOKEN;
const map = new mapboxgl.Map(MAP_OPTIONS);
map.addControl(new mapboxgl.NavigationControl({ showCompass: false }));

// Step 3.3: project a station's longitude and latitude to map pixels. Handles
// pan, zoom and rotation.
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

map.on('load', async () => {
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
  let jsonData;
  let trips;
  try {
    [jsonData, trips] = await Promise.all([
      withRetry(() => d3.json(DATA_URLS.stations), 'stations'),
      withRetry(loadTrips, 'trips'),
    ]);
  } catch (error) {
    console.error('Error loading Bluebikes data:', error);
    return;
  }
  console.log('Loaded JSON Data:', jsonData);
  console.log('Loaded trips:', trips.length);

  // Step 4.2: traffic per station over the whole day.
  const stations = computeStationTraffic(jsonData.data.stations, ANY_TIME, tripBuckets);
  console.log('Stations Array:', stations);

  // Step 4.3: area, not radius, encodes traffic.
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
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

  circles
    .on('pointerenter', function (event, d) {
      hovered = this;
      this.querySelector('title').textContent = '';
      tooltip.textContent = tooltipText(d);
      tooltip.hidden = false;
      placeTooltip(event);
    })
    .on('pointermove', placeTooltip)
    .on('pointerleave', function (event, d) {
      hovered = null;
      this.querySelector('title').textContent = tooltipText(d);
      tooltip.hidden = true;
    });

  // Big circles first, so small stations stay on top and can be hovered.
  function sortBySize() {
    circles.sort((a, b) => d3.descending(a.totalTraffic, b.totalTraffic));
  }
  sortBySize();

  // Step 3.3: keep circles aligned with the map.
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
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
      const d = d3.select(hovered).datum();
      hovered.querySelector('title').textContent = '';
      tooltip.textContent = tooltipText(d);
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
});

// Machine-readable value for <time datetime>, e.g. "08:30". 1440 is midnight.
function toTimeAttribute(minutes) {
  const wrapped = minutes % MINUTES_PER_DAY;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}
