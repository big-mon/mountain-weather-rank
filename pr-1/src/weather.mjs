import { PRESSURE_LEVELS, summarizeDay } from './core.mjs';

export function buildWeatherUrl(mountain, dates) {
  const hourly = ['precipitation', ...PRESSURE_LEVELS.flatMap((level) => ['wind_speed', 'cloud_cover', 'geopotential_height'].map((field) => `${field}_${level}hPa`))];
  const params = new URLSearchParams({
    latitude: mountain.latitude,
    longitude: mountain.longitude,
    elevation: mountain.elevationM,
    hourly: hourly.join(','),
    timezone: 'Asia/Tokyo',
    wind_speed_unit: 'ms',
    precipitation_unit: 'mm',
    start_date: dates[0],
    end_date: dates[1],
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

export async function fetchForecast(mountain, dates, signal) {
  const response = await fetch(buildWeatherUrl(mountain, dates), { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`予報を取得できませんでした（HTTP ${response.status}）。`);
  const data = await response.json();
  if (!Array.isArray(data?.hourly?.time)) throw new Error('予報データの形式を確認できませんでした。');
  return { fetchedAt: Date.now(), days: Object.fromEntries(dates.map((date) => [date, summarizeDay(data.hourly, date, mountain.elevationM)])) };
}

export function forecastCacheKey(mountain, dates) {
  return `yamabiyori.forecast.v1.${[mountain.latitude, mountain.longitude, mountain.elevationM, ...dates].join(',')}`;
}

export function readCachedForecast(storage, key, dates) {
  const value = JSON.parse(storage.getItem(key) ?? 'null');
  if (!Number.isFinite(value?.fetchedAt)) return null;
  for (const date of dates) {
    const summary = value.days?.[date];
    if (!summary || typeof summary.complete !== 'boolean') return null;
    const valid = (n, max = Infinity) => n === null || (Number.isFinite(n) && n >= 0 && n <= max);
    if (!valid(summary.maxWindMps) || !valid(summary.precipitationMm) || !valid(summary.meanCloudPct, 100)) return null;
    if (summary.complete !== [summary.maxWindMps, summary.precipitationMm, summary.meanCloudPct].every(Number.isFinite)) return null;
  }
  return value;
}
