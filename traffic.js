// Pure traffic logic for the Bikewatching map (Lab 7, Steps 4 and 5).
// Kept free of Mapbox and the DOM so it runs unchanged in the browser and in
// `node --test`. The bare 'd3' specifier resolves through the import map in
// index.html in the browser and through node_modules in tests.
import * as d3 from 'd3';

export const MINUTES_PER_DAY = 24 * 60;
// Step 5.3: a trip counts at the selected time when it starts or ends within
// this many minutes of it, on either side.
export const WINDOW_MINUTES = 60;
// Slider value meaning "no time filter" (Step 5.1).
export const ANY_TIME = -1;

// Step 5.3. Trip times are stored as UTC instants that carry Boston wall-clock
// time (see parseTripTime), so read them back in UTC.
export function minutesSinceMidnight(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

// Step 5.2: minutes since midnight to a short local time such as "8:30 AM".
export function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

// The CSV stores Boston wall-clock times as "2024-03-20 08:18:13" with no zone.
// Parsing them in the viewer's zone would shift trips for anyone whose zone
// has a DST gap in March (2:00 to 3:00 AM on 2024-03-10 does not exist in US
// zones), and the space form is engine-dependent anyway. So pin them to UTC:
// the instant is meaningless, but the hours and minutes are exactly the
// wall-clock time on every machine.
export function parseTripTime(value) {
  return new Date(`${String(value).replace(' ', 'T')}Z`);
}

// Step 5.4: one bucket per minute of the day.
export function createMinuteBuckets() {
  return Array.from({ length: MINUTES_PER_DAY }, () => []);
}

// Step 5.4: file a parsed trip under its start minute and its end minute.
// Trips with an unparseable time are skipped rather than crashing the load.
export function bucketTrip(trip, departuresByMinute, arrivalsByMinute) {
  const started = minutesSinceMidnight(trip.started_at);
  const ended = minutesSinceMidnight(trip.ended_at);
  if (Number.isInteger(started)) departuresByMinute[started].push(trip);
  if (Number.isInteger(ended)) arrivalsByMinute[ended].push(trip);
}

// Step 5.4: trips whose bucket lies within WINDOW_MINUTES of `minute`,
// wrapping across midnight. Both ends are inclusive, matching the
// `<= 60` test of the unoptimised filter in Step 5.3 (the lab's version
// drops the last minute of the window).
export function filterByMinute(tripsByMinute, minute) {
  if (minute === ANY_TIME) {
    return tripsByMinute.flat();
  }

  const minMinute = (minute - WINDOW_MINUTES + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const maxMinute = (minute + WINDOW_MINUTES) % MINUTES_PER_DAY;

  if (minMinute > maxMinute) {
    const beforeMidnight = tripsByMinute.slice(minMinute);
    const afterMidnight = tripsByMinute.slice(0, maxMinute + 1);
    return beforeMidnight.concat(afterMidnight).flat();
  }
  return tripsByMinute.slice(minMinute, maxMinute + 1).flat();
}

// Steps 4.2 and 5.4: arrivals, departures and total traffic per station for
// the selected time. Returns new station objects so the loaded data is never
// mutated; D3 rebinds them by `short_name`.
export function computeStationTraffic(
  stations,
  timeFilter,
  { departuresByMinute, arrivalsByMinute },
) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    const id = station.short_name;
    const stationArrivals = arrivals.get(id) ?? 0;
    const stationDepartures = departures.get(id) ?? 0;
    return {
      ...station,
      arrivals: stationArrivals,
      departures: stationDepartures,
      totalTraffic: stationArrivals + stationDepartures,
    };
  });
}

// Step 6.1: three flow classes. 1 = mostly departures, 0.5 = balanced,
// 0 = mostly arrivals.
export const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// A station with no trips in the window has no ratio (0 / 0). Show it as
// balanced instead of letting NaN reach CSS, where it would void the fill.
export function departureRatio(station) {
  return station.totalTraffic > 0
    ? stationFlow(station.departures / station.totalTraffic)
    : 0.5;
}

// Step 4.4: tooltip text.
export function tooltipText(station) {
  return `${station.totalTraffic} trips (${station.departures} departures, ${station.arrivals} arrivals)`;
}

// Data validation. A server can answer 200 with the wrong body (an HTML error
// page, an empty file, a different JSON shape). These checks run inside the
// load-and-retry path, so bad content is retried and then reported exactly
// like a failed download, instead of drawing a map of zeros.
export const TRIP_COLUMNS = ['started_at', 'ended_at', 'start_station_id', 'end_station_id'];

export function validateStations(json) {
  const stations = json?.data?.stations;
  if (!Array.isArray(stations) || stations.length === 0) {
    throw new Error('Station data has no data.stations list');
  }
  const ids = new Set();
  for (const station of stations) {
    const id = station?.short_name;
    if (typeof id !== 'string' || id === '' || ids.has(id)) {
      throw new Error(`Station data has a missing or duplicate short_name: ${id}`);
    }
    if (!Number.isFinite(+station.lon) || !Number.isFinite(+station.lat)) {
      throw new Error(`Station ${id} has no usable coordinates`);
    }
    ids.add(id);
  }
  return stations;
}

export function validateTrips(trips) {
  const missing = TRIP_COLUMNS.filter((column) => !trips?.columns?.includes(column));
  if (missing.length > 0) throw new Error(`Trip data is missing columns: ${missing.join(', ')}`);
  const usable = trips.filter(
    (trip) => Number.isFinite(trip.started_at?.getTime()) && Number.isFinite(trip.ended_at?.getTime()),
  );
  if (usable.length === 0) throw new Error('Trip data has no rows with valid times');
  return trips;
}
