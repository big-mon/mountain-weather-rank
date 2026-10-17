import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getWeekend, japanDate, isFresh, CACHE_TTL_MS, PRESSURE_LEVELS, SAMPLE_MOUNTAINS, validateMountain, interpolateAtElevation, summarizeDay, comparisonCost, rankMountains, forecastStatus } from '../src/core.mjs';
import { buildWeatherUrl, fetchForecast, forecastCacheKey, readCachedForecast } from '../src/weather.mjs';

const date = '2026-10-17';
const dates = [date, '2026-10-18'];
function hourlyFixture() {
  const hourly = { time: Array.from({ length: 24 }, (_, hour) => `${date}T${String(hour).padStart(2, '0')}:00`), precipitation: Array(24).fill(1) };
  for (const [index, level] of PRESSURE_LEVELS.entries()) {
    hourly[`geopotential_height_${level}hPa`] = Array(24).fill(index * 500);
    hourly[`wind_speed_${level}hPa`] = Array(24).fill(index * 2);
    hourly[`cloud_cover_${level}hPa`] = Array(24).fill(index * 10);
  }
  return hourly;
}

test('weekend dates use Japan time across weekdays, months, and years', () => {
  for (const [input, expectedDates, selected] of [
    ['2026-10-16T12:00:00+09:00', ['2026-10-17', '2026-10-18'], '2026-10-17'],
    ['2026-10-17T16:00:00+09:00', ['2026-10-17', '2026-10-18'], '2026-10-17'],
    ['2026-10-18T12:00:00+09:00', ['2026-10-17', '2026-10-18'], '2026-10-18'],
    ['2026-10-19T00:00:00+09:00', ['2026-10-24', '2026-10-25'], '2026-10-24'],
    ['2026-10-30T12:00:00+09:00', ['2026-10-31', '2026-11-01'], '2026-10-31'],
    ['2027-12-31T12:00:00+09:00', ['2028-01-01', '2028-01-02'], '2028-01-01'],
    ['2026-10-17T15:00:00Z', ['2026-10-17', '2026-10-18'], '2026-10-18'],
  ]) assert.deepEqual(getWeekend(new Date(input)), { dates: expectedDates, selectedDate: selected });
  assert.equal(japanDate(new Date('2026-10-18T15:00:00Z')), '2026-10-19');
});

test('height interpolation uses actual heights and never extrapolates or treats null as zero', () => {
  const hourly = hourlyFixture();
  assert.equal(interpolateAtElevation(hourly, 6, 750, 'wind_speed'), 3);
  assert.equal(interpolateAtElevation(hourly, 6, 1000, 'cloud_cover'), 20);
  assert.equal(interpolateAtElevation(hourly, 6, 5000, 'wind_speed'), null);
  assert.equal(interpolateAtElevation(hourly, 6, -1, 'wind_speed'), null);
  for (const level of PRESSURE_LEVELS) hourly[`wind_speed_${level}hPa`][6] = null;
  assert.equal(interpolateAtElevation(hourly, 6, 750, 'wind_speed'), null);
});

test('6–15 aggregation includes ten instantaneous values and nine preceding-hour precipitation values', () => {
  const hourly = hourlyFixture();
  hourly.precipitation[6] = 100;
  hourly.precipitation[16] = 100;
  hourly.wind_speed_975hPa[15] = 10;
  hourly.wind_speed_950hPa[15] = 12;
  hourly.wind_speed_975hPa[16] = 100;
  hourly.wind_speed_950hPa[16] = 100;
  assert.deepEqual(summarizeDay(hourly, date, 750), { maxWindMps: 11, precipitationMm: 9, meanCloudPct: 15, complete: true });
});

test('a missing hour or variable makes the day ineligible, retaining other complete metrics', () => {
  const hourly = hourlyFixture();
  hourly.precipitation[7] = null;
  assert.deepEqual(summarizeDay(hourly, date, 750), { maxWindMps: 3, precipitationMm: null, meanCloudPct: 15, complete: false, reason: 'missing' });
  assert.deepEqual(summarizeDay(hourly, '2026-10-18', 750), { maxWindMps: null, precipitationMm: null, meanCloudPct: null, complete: false, reason: 'missing' });
  assert.deepEqual(summarizeDay(hourlyFixture(), date, 9000), { maxWindMps: null, precipitationMm: 9, meanCloudPct: null, complete: false, reason: 'elevation' });
  hourly.time[10] = '2026-10-17T10:30';
  assert.equal(summarizeDay(hourly, date, 750).maxWindMps, null);
  assert.equal(summarizeDay(hourly, date, 750).reason, 'missing');
});

test('one hour outside the pressure range is an elevation failure, not a retryable shortage', () => {
  const hourly = hourlyFixture();
  for (const level of PRESSURE_LEVELS) hourly[`geopotential_height_${level}hPa`][10] = 5000 + level;
  const summary = summarizeDay(hourly, date, 750);
  assert.equal(summary.complete, false);
  assert.equal(summary.reason, 'elevation');
  assert.equal(summary.maxWindMps, null);
  assert.equal(summary.precipitationMm, 9);
  assert.equal(forecastStatus({ fetchedAt: Date.now(), days: { [date]: summary } }, date), 'elevation');
  const unknownHeight = hourlyFixture();
  for (const level of PRESSURE_LEVELS) unknownHeight[`geopotential_height_${level}hPa`][10] = null;
  const unknownSummary = summarizeDay(unknownHeight, date, 750);
  assert.equal(unknownSummary.reason, 'missing');
  assert.equal(forecastStatus({ fetchedAt: Date.now(), days: { [date]: unknownSummary } }, date), 'incomplete');
  const missingTimestamp = hourlyFixture();
  missingTimestamp.time[12] = `${date}T12:30`;
  const missingTimestampSummary = summarizeDay(missingTimestamp, date, 750);
  assert.equal(missingTimestampSummary.reason, 'missing');
  assert.equal(forecastStatus({ fetchedAt: Date.now(), days: { [date]: missingTimestampSummary } }, date), 'incomplete');
  const mixed = hourlyFixture();
  for (const level of PRESSURE_LEVELS) {
    mixed[`geopotential_height_${level}hPa`][10] = 5000 + level;
    mixed[`geopotential_height_${level}hPa`][11] = null;
  }
  assert.equal(summarizeDay(mixed, date, 750).reason, 'elevation');
});

test('weights reward lower wind, precipitation and cloud independently without capping extremes', () => {
  const base = { maxWindMps: 0, precipitationMm: 0, meanCloudPct: 0 };
  assert.equal(comparisonCost(base), 0);
  assert.equal(comparisonCost({ ...base, maxWindMps: 10 }), 0.5);
  assert.equal(comparisonCost({ ...base, precipitationMm: 10 }), 0.35);
  assert.equal(comparisonCost({ ...base, meanCloudPct: 100 }), 0.15);
  assert.ok(comparisonCost({ ...base, maxWindMps: 30 }) > comparisonCost({ ...base, maxWindMps: 20 }));
});

test('calmer, drier, and clearer mountains rank ahead of harsher ones', () => {
  const mountains = [
    { id: 'windy', name: '風', latitude: 36, longitude: 138, elevationM: 1000 },
    { id: 'wet', name: '雨', latitude: 36, longitude: 139, elevationM: 1000 },
    { id: 'calm', name: '穏', latitude: 36, longitude: 140, elevationM: 1000 },
  ];
  const now = Date.now();
  const day = (maxWindMps, precipitationMm, meanCloudPct) => ({ maxWindMps, precipitationMm, meanCloudPct, complete: true });
  const forecasts = new Map([
    ['windy', { fetchedAt: now, days: { [date]: day(12, 0, 0) } }],
    ['wet', { fetchedAt: now, days: { [date]: day(0, 10, 0) } }],
    ['calm', { fetchedAt: now, days: { [date]: day(1, 0, 10) } }],
  ]);
  assert.deepEqual(rankMountains(mountains, forecasts, date, now).map(({ mountain, rank }) => [mountain.id, rank]), [
    ['calm', 1],
    ['wet', 2],
    ['windy', 3],
  ]);
});

test('forecast status distinguishes loading, stale data, failed refresh, and elevation', () => {
  const now = Date.now();
  const summary = { maxWindMps: 3, precipitationMm: 0, meanCloudPct: 0, complete: true };
  assert.equal(forecastStatus(undefined, date, now), 'loading');
  assert.equal(forecastStatus({ loading: true, days: { [date]: summary }, fetchedAt: now }, date, now), 'loading');
  assert.equal(forecastStatus({ fetchedAt: now, days: { [date]: summary } }, date, now), 'ok');
  assert.equal(forecastStatus({ fetchedAt: now - CACHE_TTL_MS, days: { [date]: summary } }, date, now), 'stale');
  assert.equal(forecastStatus({ error: 'offline' }, date, now), 'error');
  assert.equal(forecastStatus({ error: 'offline', fetchedAt: now, days: { [date]: summary } }, date, now), 'refresh-failed');
  assert.equal(forecastStatus({ fetchedAt: now, days: { [date]: { ...summary, complete: false, reason: 'missing' } } }, date, now), 'incomplete');
  assert.equal(forecastStatus({ fetchedAt: now, days: { [date]: { ...summary, maxWindMps: null, complete: false, reason: 'elevation' } } }, date, now), 'elevation');
});

test('ties keep favorite order; stale, missing and failed forecasts never receive a rank', () => {
  const mountains = SAMPLE_MOUNTAINS;
  const now = Date.now();
  const days = { [date]: { maxWindMps: 3, precipitationMm: 0, meanCloudPct: 0, complete: true } };
  const forecasts = new Map([
    [mountains[0].id, { fetchedAt: now - CACHE_TTL_MS, days }],
    [mountains[1].id, { fetchedAt: now, days }],
    [mountains[2].id, { fetchedAt: now, days }],
    [mountains[3].id, { fetchedAt: now, days: { [date]: { ...days[date], complete: false } } }],
    [mountains[4].id, { error: 'offline' }],
  ]);
  const ranked = rankMountains(mountains, forecasts, date, now);
  assert.deepEqual(ranked.map(({ mountain }) => mountain.id), ['tsukuba', 'tanzawa', 'takao', 'daibosatsu', 'kumotori']);
  assert.deepEqual(ranked.map(({ rank }) => rank), [1, 2, null, null, null]);
  assert.ok(rankMountains(mountains, new Map(), date, now).every(({ rank }) => rank === null));
  assert.equal(isFresh(now, now), true);
  assert.equal(isFresh(now + 1, now), false);
  assert.equal(isFresh(null, now), false);
  assert.equal(isFresh(now - CACHE_TTL_MS + 1, now), true);
});

test('mountain validation rejects blank names and nonfinite or out-of-range coordinates', () => {
  const mountain = SAMPLE_MOUNTAINS[0];
  assert.equal(validateMountain(mountain), null);
  for (const change of [{ name: '  ' }, { name: '山'.repeat(51) }, { latitude: NaN }, { latitude: 91 }, { longitude: -181 }, { elevationM: -1 }, { elevationM: Infinity }]) assert.ok(validateMountain({ ...mountain, ...change }));
});

test('API request and cache identity include coordinates, elevation and the exact weekend', () => {
  const mountain = SAMPLE_MOUNTAINS[0];
  const url = new URL(buildWeatherUrl(mountain, dates));
  assert.equal(url.searchParams.get('timezone'), 'Asia/Tokyo');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'ms');
  assert.equal(url.searchParams.get('elevation'), '599');
  assert.equal(url.searchParams.get('start_date'), dates[0]);
  assert.equal(url.searchParams.get('end_date'), dates[1]);
  assert.ok(url.searchParams.get('hourly').includes('geopotential_height_600hPa'));
  const key = forecastCacheKey(mountain, dates);
  assert.equal(forecastCacheKey({ ...mountain, name: '別名' }, dates), key);
  assert.notEqual(forecastCacheKey({ ...mountain, elevationM: 600 }, dates), key);
  assert.notEqual(forecastCacheKey(mountain, ['2026-10-24', '2026-10-25']), key);
});

test('cache reader rejects corrupted summaries including nulls incorrectly marked complete', () => {
  const summary = { maxWindMps: 3, precipitationMm: 9, meanCloudPct: 15, complete: true };
  const value = { fetchedAt: Date.now(), days: Object.fromEntries(dates.map((date) => [date, { ...summary }])) };
  const storage = { getItem: () => JSON.stringify(value) };
  assert.deepEqual(readCachedForecast(storage, 'key', dates), value);
  value.days[date].maxWindMps = null;
  assert.equal(readCachedForecast(storage, 'key', dates), null);
  value.days[date].complete = false;
  assert.deepEqual(readCachedForecast(storage, 'key', dates), value);
});

test('failed HTTP or malformed responses are reported, while successful responses are summarized', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(init);
    return { ok: false, status: 429 };
  });
  await assert.rejects(fetchForecast(SAMPLE_MOUNTAINS[0], dates), /HTTP 429/);
  assert.equal(requests[0].cache, 'no-store');
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ error: true }) }));
  await assert.rejects(fetchForecast(SAMPLE_MOUNTAINS[0], dates), /形式/);
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ hourly: hourlyFixture() }) }));
  const result = await fetchForecast({ ...SAMPLE_MOUNTAINS[0], elevationM: 750 }, dates);
  assert.equal(result.days[date].maxWindMps, 3);
  assert.equal(result.days[dates[1]].complete, false);
  assert.equal(result.days[dates[1]].reason, 'missing');
});

test('published page keeps asset URLs relative to /mountain-weather-rank/', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/src\/app\.mjs"/);
  assert.match(html, /href="\.\/favicon\.svg"/);
  assert.doesNotMatch(html, /(?:href|src)=["']\//);
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /(?:import|from)\s+["']\//);
});
