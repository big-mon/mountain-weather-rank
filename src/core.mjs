export const PRESSURE_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600];
export const CACHE_TTL_MS = 30 * 60 * 1000;
export const MAX_MOUNTAINS = 5;

// Source: https://maps.gsi.go.jp/3d/mountain/mountain.html (DMS converted to degrees)
export const SAMPLE_MOUNTAINS = [
  { id: 'takao', name: '高尾山', latitude: 35 + 37 / 60 + 31 / 3600, longitude: 139 + 14 / 60 + 37 / 3600, elevationM: 599 },
  { id: 'tsukuba', name: '筑波山', latitude: 36 + 13 / 60 + 31 / 3600, longitude: 140 + 6 / 60 + 24 / 3600, elevationM: 877 },
  { id: 'tanzawa', name: '丹沢山', latitude: 35 + 28 / 60 + 27 / 3600, longitude: 139 + 9 / 60 + 46 / 3600, elevationM: 1567 },
  { id: 'daibosatsu', name: '大菩薩嶺', latitude: 35 + 44 / 60 + 56 / 3600, longitude: 138 + 50 / 60 + 44 / 3600, elevationM: 2057 },
  { id: 'kumotori', name: '雲取山', latitude: 35 + 51 / 60 + 20 / 3600, longitude: 138 + 56 / 60 + 38 / 3600, elevationM: 2017 },
];

export function japanDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function getWeekend(now = new Date()) {
  const today = new Date(`${japanDate(now)}T00:00:00Z`);
  const weekday = today.getUTCDay();
  today.setUTCDate(today.getUTCDate() + (weekday === 0 ? -1 : 6 - weekday));
  const saturday = today.toISOString().slice(0, 10);
  today.setUTCDate(today.getUTCDate() + 1);
  const sunday = today.toISOString().slice(0, 10);
  return { dates: [saturday, sunday], selectedDate: weekday === 0 ? sunday : saturday };
}

export function isFresh(fetchedAt, now = Date.now()) {
  return Number.isFinite(fetchedAt) && fetchedAt <= now && now - fetchedAt < CACHE_TTL_MS;
}

export function validateMountain(mountain) {
  if (typeof mountain?.name !== 'string' || !mountain.name.trim() || mountain.name.trim().length > 50) return '山名を50文字以内で入力してください。';
  if (!Number.isFinite(mountain.latitude) || Math.abs(mountain.latitude) > 90) return '緯度を−90〜90の数値で入力してください。';
  if (!Number.isFinite(mountain.longitude) || Math.abs(mountain.longitude) > 180) return '経度を−180〜180の数値で入力してください。';
  if (!Number.isFinite(mountain.elevationM) || mountain.elevationM < 0 || mountain.elevationM > 9000) return '標高を0〜9,000mの数値で入力してください。';
  return null;
}

export function interpolateAtElevation(hourly, index, elevationM, field) {
  const points = PRESSURE_LEVELS.map((level) => ({
    height: hourly[`geopotential_height_${level}hPa`]?.[index],
    value: hourly[`${field}_${level}hPa`]?.[index],
  })).filter(({ height, value }) => Number.isFinite(height) && Number.isFinite(value) && value >= 0 && (field !== 'cloud_cover' || value <= 100)).sort((a, b) => a.height - b.height);
  const exact = points.find((point) => point.height === elevationM);
  if (exact) return exact.value;
  for (let i = 1; i < points.length; i++) {
    const lower = points[i - 1];
    const upper = points[i];
    if (lower.height < elevationM && elevationM < upper.height) {
      return lower.value + (upper.value - lower.value) * (elevationM - lower.height) / (upper.height - lower.height);
    }
  }
  return null;
}

export function comparisonCost({ maxWindMps, precipitationMm, meanCloudPct }) {
  return 0.50 * maxWindMps / 10 + 0.35 * precipitationMm / 10 + 0.15 * meanCloudPct / 100;
}

function hourIndex(hourly, date, hour) {
  const times = Array.isArray(hourly?.time) ? hourly.time : [];
  return times.indexOf(`${date}T${String(hour).padStart(2, '0')}:00`);
}

// null means the hour has no height data, so the cause is unknown.
function elevationCovered(hourly, index, elevationM) {
  const heights = PRESSURE_LEVELS.map((level) => hourly?.[`geopotential_height_${level}hPa`]?.[index]).filter(Number.isFinite);
  if (heights.length === 0) return null;
  return elevationM >= Math.min(...heights) && elevationM <= Math.max(...heights);
}

// One hour known to sit outside the pressure-height envelope makes the day an
// elevation failure. A missing timestamp, or an hour with no height data, is not
// elevation evidence by itself.
function elevationOutsideForecast(hourly, date, elevationM) {
  let outside = false;
  for (let hour = 6; hour <= 15; hour++) {
    const index = hourIndex(hourly, date, hour);
    if (index < 0) continue;
    if (elevationCovered(hourly, index, elevationM) === false) outside = true;
  }
  return outside;
}

export function summarizeDay(hourly, date, elevationM) {
  const winds = [];
  const clouds = [];
  const precipitation = [];
  for (let hour = 6; hour <= 15; hour++) {
    const index = hourIndex(hourly, date, hour);
    winds.push(index < 0 ? null : interpolateAtElevation(hourly, index, elevationM, 'wind_speed'));
    clouds.push(index < 0 ? null : interpolateAtElevation(hourly, index, elevationM, 'cloud_cover'));
    if (hour > 6) {
      const value = hourly?.precipitation?.[index];
      precipitation.push(Number.isFinite(value) && value >= 0 ? value : null);
    }
  }
  const allValid = (values) => values.every(Number.isFinite);
  const summary = {
    maxWindMps: allValid(winds) ? Math.max(...winds) : null,
    precipitationMm: allValid(precipitation) ? precipitation.reduce((sum, value) => sum + value, 0) : null,
    meanCloudPct: allValid(clouds) ? clouds.reduce((sum, value) => sum + value, 0) / clouds.length : null,
  };
  summary.complete = Object.values(summary).every(Number.isFinite);
  if (!summary.complete) summary.reason = elevationOutsideForecast(hourly, date, elevationM) ? 'elevation' : 'missing';
  return summary;
}

export function forecastStatus(forecast, date, now = Date.now()) {
  if (!forecast || forecast.loading) return 'loading';
  const summary = forecast.days?.[date];
  if (summary && !isFresh(forecast.fetchedAt, now)) return 'stale';
  if (forecast.error) return summary ? 'refresh-failed' : 'error';
  if (!summary?.complete) return summary?.reason === 'elevation' ? 'elevation' : 'incomplete';
  return 'ok';
}

export function rankMountains(mountains, forecasts, date, now = Date.now()) {
  const entries = mountains.map((mountain, index) => {
    const forecast = forecasts.get(mountain.id);
    const summary = forecast?.days?.[date];
    const eligible = summary?.complete === true && isFresh(forecast.fetchedAt, now);
    return { mountain, forecast, summary, index, eligible, cost: eligible ? comparisonCost(summary) : Infinity };
  });
  entries.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.eligible && a.cost !== b.cost) return a.cost - b.cost;
    return a.index - b.index;
  });
  return entries.map((entry, index) => ({ ...entry, rank: entry.eligible ? index + 1 : null }));
}
