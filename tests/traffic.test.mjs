// Unit and data tests for traffic.js. Run: pnpm test
// The real-data test fetches the course CSV (about 6.5 MB gzipped). Its
// expected numbers come from an independent Python pass over the same file,
// counting departures by start minute and arrivals by end minute within
// 60 minutes either side, wrapping at midnight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as d3 from 'd3';
import {
  ANY_TIME,
  bucketTrip,
  computeStationTraffic,
  createMinuteBuckets,
  departureRatio,
  filterByMinute,
  formatTime,
  minutesSinceMidnight,
  parseTripTime,
  tooltipText,
  validateStations,
  validateTrips,
} from '../traffic.js';

const STATIONS_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
const TRIPS_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';

function trip(id, start, end, from, to) {
  return {
    ride_id: id,
    started_at: parseTripTime(start),
    ended_at: parseTripTime(end),
    start_station_id: from,
    end_station_id: to,
  };
}

function bucketsFor(trips) {
  const departuresByMinute = createMinuteBuckets();
  const arrivalsByMinute = createMinuteBuckets();
  for (const t of trips) bucketTrip(t, departuresByMinute, arrivalsByMinute);
  return { departuresByMinute, arrivalsByMinute };
}

test('parseTripTime keeps wall-clock time in any zone, including the DST gap', () => {
  // 02:30 on 2024-03-10 does not exist in US zones; it must still read 150.
  assert.equal(minutesSinceMidnight(parseTripTime('2024-03-10 02:30:00')), 150);
  assert.equal(minutesSinceMidnight(parseTripTime('2024-03-20 08:18:13')), 498);
  assert.equal(minutesSinceMidnight(parseTripTime('2024-03-20 23:59:59')), 1439);
  assert.equal(minutesSinceMidnight(parseTripTime('2024-03-20 00:00:00')), 0);
});

test('formatTime renders slider minutes as a short US time', () => {
  // Intl may use a narrow no-break space before AM/PM; compare normalised.
  const norm = (s) => s.replace(/\s/g, ' ');
  assert.equal(norm(formatTime(0)), '12:00 AM');
  assert.equal(norm(formatTime(510)), '8:30 AM');
  assert.equal(norm(formatTime(1020)), '5:00 PM');
  assert.equal(norm(formatTime(1440)), '12:00 AM');
});

test('filterByMinute window is inclusive on both ends and wraps midnight', () => {
  const buckets = createMinuteBuckets().map((_, m) => [m]);
  const window = (t) => filterByMinute(buckets, t).sort((a, b) => a - b);

  assert.equal(filterByMinute(buckets, ANY_TIME).length, 1440);
  assert.deepEqual(window(480), d3.range(420, 541));
  assert.equal(window(480).length, 121);

  const midnight = window(0);
  assert.equal(midnight.length, 121);
  assert.deepEqual(midnight, [...d3.range(0, 61), ...d3.range(1380, 1440)]);
  assert.deepEqual(window(1440), midnight, 'slider max 1440 is midnight');

  const late = window(1410);
  assert.equal(late.length, 121);
  assert.ok(late.includes(1350) && late.includes(1439) && late.includes(30));
  assert.ok(!late.includes(31) && !late.includes(1349));

  const early = window(30);
  assert.equal(early.length, 121);
  assert.ok(early.includes(1410) && early.includes(90) && !early.includes(91));
});

test('computeStationTraffic counts departures by start time and arrivals by end time', () => {
  const stations = [{ short_name: 'A' }, { short_name: 'B' }, { short_name: 'C' }];
  const trips = [
    trip(1, '2024-03-01 08:00:00', '2024-03-01 08:20:00', 'A', 'B'),
    trip(2, '2024-03-01 08:10:00', '2024-03-01 08:15:00', 'A', 'A'),
    trip(3, '2024-03-01 17:00:00', '2024-03-01 17:30:00', 'B', 'A'),
  ];
  const buckets = bucketsFor(trips);

  const all = computeStationTraffic(stations, ANY_TIME, buckets);
  assert.deepEqual(
    all.map(({ short_name, departures, arrivals, totalTraffic }) => [short_name, departures, arrivals, totalTraffic]),
    [
      ['A', 2, 2, 4],
      ['B', 1, 1, 2],
      ['C', 0, 0, 0],
    ],
  );

  const morning = computeStationTraffic(stations, 8 * 60, buckets);
  assert.deepEqual(morning.map((s) => s.totalTraffic), [3, 1, 0]);

  // 18:31 is 61 minutes after the 17:30 arrival: excluded. 18:30 is included.
  assert.deepEqual(computeStationTraffic(stations, 18 * 60 + 31, buckets).map((s) => s.totalTraffic), [0, 0, 0]);
  assert.deepEqual(computeStationTraffic(stations, 18 * 60 + 30, buckets).map((s) => s.totalTraffic), [1, 0, 0]);

  assert.equal(stations[0].totalTraffic, undefined, 'input stations are not mutated');
});

test('departureRatio maps to three classes and never yields NaN', () => {
  assert.equal(departureRatio({ departures: 9, arrivals: 1, totalTraffic: 10 }), 1);
  assert.equal(departureRatio({ departures: 5, arrivals: 5, totalTraffic: 10 }), 0.5);
  assert.equal(departureRatio({ departures: 1, arrivals: 9, totalTraffic: 10 }), 0);
  assert.equal(departureRatio({ departures: 0, arrivals: 0, totalTraffic: 0 }), 0.5);
});

test('tooltip text matches the lab format', () => {
  assert.equal(
    tooltipText({ totalTraffic: 12, departures: 5, arrivals: 7 }),
    '12 trips (5 departures, 7 arrivals)',
  );
});

test('real March 2024 data matches the independent reference', async () => {
  const [json, csvText] = await Promise.all([
    fetch(STATIONS_URL).then((r) => r.json()),
    fetch(TRIPS_URL).then((r) => r.text()),
  ]);
  const departuresByMinute = createMinuteBuckets();
  const arrivalsByMinute = createMinuteBuckets();
  const trips = d3.csvParse(csvText, (t) => {
    t.started_at = parseTripTime(t.started_at);
    t.ended_at = parseTripTime(t.ended_at);
    bucketTrip(t, departuresByMinute, arrivalsByMinute);
    return t;
  });
  const buckets = { departuresByMinute, arrivalsByMinute };
  const stations = json.data.stations;

  assert.equal(trips.length, 261687);
  assert.equal(stations.length, 453);
  assert.equal(d3.sum(departuresByMinute, (b) => b.length), trips.length, 'every trip bucketed by start');
  assert.equal(d3.sum(arrivalsByMinute, (b) => b.length), trips.length, 'every trip bucketed by end');

  // [timeFilter, busiest station, its total, departures, arrivals, sum over stations, zero-traffic stations]
  const expected = [
    [ANY_TIME, 'M32006', 11174, 5614, 5560, 500419, 39],
    [0, 'M32006', 233, 132, 101, 11648, 91],
    [480, 'A32010', 921, 413, 508, 55673, 68],
    [1020, 'M32006', 2154, 1218, 936, 99464, 49],
    [1410, 'M32006', 316, 174, 142, 14885, 90],
    [1440, 'M32006', 233, 132, 101, 11648, 91],
  ];
  for (const [t, top, total, dep, arr, sum, zero] of expected) {
    const result = computeStationTraffic(stations, t, buckets);
    const busiest = d3.greatest(result, (s) => s.totalTraffic);
    assert.deepEqual(
      [busiest.short_name, busiest.totalTraffic, busiest.departures, busiest.arrivals],
      [top, total, dep, arr],
      `busiest station at ${t}`,
    );
    assert.equal(d3.sum(result, (s) => s.totalTraffic), sum, `sum at ${t}`);
    assert.equal(result.filter((s) => s.totalTraffic === 0).length, zero, `zero stations at ${t}`);
  }
});

test('validateStations rejects wrong shapes, duplicates and bad coordinates', () => {
  const good = { data: { stations: [{ short_name: 'A', lon: -71.1, lat: 42.3 }, { short_name: 'B', lon: '-71.2', lat: '42.4' }] } };
  assert.equal(validateStations(good).length, 2);
  assert.throws(() => validateStations({}), /no data.stations/);
  assert.throws(() => validateStations({ data: { stations: [] } }), /no data.stations/);
  assert.throws(() => validateStations(null), /no data.stations/);
  assert.throws(() => validateStations({ data: { stations: [{ short_name: 'A', lon: 1, lat: 1 }, { short_name: 'A', lon: 1, lat: 1 }] } }), /duplicate/);
  assert.throws(() => validateStations({ data: { stations: [{ lon: 1, lat: 1 }] } }), /short_name/);
  assert.throws(() => validateStations({ data: { stations: [{ short_name: 'A', lon: 'x', lat: 1 }] } }), /coordinates/);
});

test('validateTrips rejects empty, HTML and column-less bodies', () => {
  const parse = (text) => d3.csvParse(text, (t) => ({ ...t, started_at: parseTripTime(t.started_at), ended_at: parseTripTime(t.ended_at) }));
  const header = 'ride_id,bike_type,started_at,ended_at,start_station_id,end_station_id,is_member';
  assert.equal(validateTrips(parse(`${header}\n1,classic,2024-03-01 08:00:00,2024-03-01 08:10:00,A,B,1`)).length, 1);
  assert.throws(() => validateTrips(parse('')), /missing columns/);
  assert.throws(() => validateTrips(parse('<!DOCTYPE html><html><body>Service unavailable</body></html>')), /missing columns/);
  assert.throws(() => validateTrips(parse(header)), /no rows/);
  assert.throws(() => validateTrips(parse(`${header}\n1,classic,soon,later,A,B,1`)), /no rows/);
});
