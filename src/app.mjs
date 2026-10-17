import { SAMPLE_MOUNTAINS, MAX_MOUNTAINS, getWeekend, isFresh, validateMountain, rankMountains } from './core.mjs';
import { fetchForecast, forecastCacheKey, readCachedForecast } from './weather.mjs';

const $ = (selector) => document.querySelector(selector);
const favoritesKey = 'yamabiyori.mountains';
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = (value, digits = 1) => Number.isFinite(value) ? value.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const dateLabel = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
const timeLabel = (timestamp) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp);

let storageWarning = '';
let mountains = loadMountains();
let weekend = getWeekend();
let selectedDate = weekend.selectedDate;
let editingId = null;
const forecasts = new Map();
const controllers = new Map();

function loadMountains() {
  try {
    const raw = localStorage.getItem(favoritesKey);
    if (raw === null) {
      const samples = structuredClone(SAMPLE_MOUNTAINS);
      localStorage.setItem(favoritesKey, JSON.stringify({ version: 1, mountains: samples }));
      return samples;
    }
    const saved = JSON.parse(raw);
    if (saved?.version !== 1 || !Array.isArray(saved.mountains) || saved.mountains.length > MAX_MOUNTAINS || saved.mountains.some((mountain) => validateMountain(mountain) || typeof mountain.id !== 'string' || !mountain.id) || new Set(saved.mountains.map((m) => m.id)).size !== saved.mountains.length) {
      throw new Error('invalid favorites');
    }
    return saved.mountains;
  } catch {
    storageWarning = '保存データを読み込めませんでした。山を登録してお使いください。ブラウザの保存設定もご確認ください。';
    return [];
  }
}

function saveMountains() {
  try {
    localStorage.setItem(favoritesKey, JSON.stringify({ version: 1, mountains }));
    storageWarning = '';
  } catch {
    storageWarning = 'ブラウザに保存できませんでした。現在の登録はこの画面を開いている間だけ保持されます。';
  }
}

function forecastCell(forecast, date) {
  const summary = forecast?.days?.[date];
  const stale = summary && !isFresh(forecast.fetchedAt);
  let status = '';
  if (forecast?.loading) status = '取得中…';
  else if (stale) status = `古い予報 · ${timeLabel(forecast.fetchedAt)}取得`;
  else if (forecast?.error) status = '取得できませんでした';
  else if (!summary?.complete) status = 'データ不足 · 順位対象外';
  return `<td class="day-forecast ${date === selectedDate ? 'is-selected' : ''} ${stale ? 'is-stale' : ''}">
    <div class="day-caption">${dateLabel(date)}（${date === weekend.dates[0] ? '土' : '日'}）</div>
    <dl class="weather-metrics">
      <div><dt>最大風速</dt><dd>${number(summary?.maxWindMps)}<span>m/s</span></dd></div>
      <div><dt>合計降水</dt><dd>${number(summary?.precipitationMm)}<span>mm</span></dd></div>
      <div><dt>平均雲量</dt><dd>${number(summary?.meanCloudPct, 0)}<span>%</span></dd></div>
    </dl>${status ? `<p class="forecast-status">${escapeHtml(status)}</p>` : ''}</td>`;
}

function render() {
  const active = $('#mountain-list').contains(document.activeElement) ? { id: document.activeElement.dataset.id, action: document.activeElement.dataset.action } : null;
  const dates = weekend.dates;
  const sundayYear = dates[0].slice(0, 4) === dates[1].slice(0, 4) ? '' : `${dates[1].slice(0, 4)}年 `;
  $('#weekend-range').textContent = `${dates[0].slice(0, 4)}年 ${dateLabel(dates[0])}（土）– ${sundayYear}${dateLabel(dates[1])}（日）`;
  $('#add-mountain').disabled = mountains.length >= MAX_MOUNTAINS;
  $('#add-mountain').title = mountains.length >= MAX_MOUNTAINS ? '最大5山まで登録できます。山の編集ボタンから変更・削除できます。' : '';
  for (const [index, id] of ['#saturday-tab', '#sunday-tab'].entries()) {
    $(id).textContent = `${dateLabel(dates[index])} ${index === 0 ? '土' : '日'}`;
    $(id).setAttribute('aria-pressed', String(selectedDate === dates[index]));
    const heading = $(index === 0 ? '#saturday-heading' : '#sunday-heading');
    heading.querySelector('.date-heading').textContent = `${dateLabel(dates[index])}（${index === 0 ? '土' : '日'}）`;
    heading.classList.toggle('is-selected', selectedDate === dates[index]);
  }
  $('#ranking-description').textContent = `${dateLabel(selectedDate)}（${selectedDate === dates[0] ? '土' : '日'}）の天気条件がよい順`;
  const loadingCount = mountains.filter((m) => forecasts.get(m.id)?.loading).length;
  $('#refresh').disabled = loadingCount > 0 || mountains.length === 0;
  const timestamps = mountains.map((m) => forecasts.get(m.id)?.fetchedAt).filter(Number.isFinite);
  $('#updated-at').textContent = loadingCount ? `予報を取得中 · 残り${loadingCount}山` : timestamps.length ? `取得 ${timeLabel(Math.min(...timestamps))}（日本時間）` : mountains.length ? '取得済みの予報がありません' : '';
  const entries = rankMountains(mountains, forecasts, selectedDate);
  const noRanks = mountains.length > 0 && !loadingCount && !entries.some((entry) => entry.eligible);
  const notice = [storageWarning, noRanks ? '比較できる予報がありません。各山の状態を確認して、再取得してください。' : ''].filter(Boolean).join(' ');
  $('#notice').textContent = notice;
  $('#notice').hidden = !notice;
  $('#empty-state').hidden = mountains.length !== 0;
  $('#forecast-table').hidden = mountains.length === 0;
  $('#load-status').textContent = loadingCount ? `${loadingCount}山の予報を取得しています。` : `${entries.filter((entry) => entry.eligible).length}山の予報を比較できます。`;
  $('#mountain-list').innerHTML = entries.map(({ mountain, forecast, rank }) => {
    const retry = !forecast?.loading && (forecast?.error || !isFresh(forecast?.fetchedAt) || !forecast?.days?.[selectedDate]?.complete);
    return `<tr class="mountain-row">
      <th scope="row" class="mountain-cell">
        <div class="mountain-info">
          <span class="rank ${rank ? '' : 'unranked'}"><span class="sr-only">${rank ? '順位' : '順位対象外'}</span>${rank ?? '—'}</span>
          <div class="mountain-name"><h2>${escapeHtml(mountain.name)}</h2><p>${number(mountain.elevationM, Number.isInteger(mountain.elevationM) ? 0 : 1)} m</p></div>
          <button class="text-button edit-button" type="button" data-action="edit" data-id="${escapeHtml(mountain.id)}" aria-label="${escapeHtml(mountain.name)}を編集">編集</button>
        </div>
        ${retry ? `<button class="text-button retry-button" type="button" data-action="retry" data-id="${escapeHtml(mountain.id)}">予報を再取得</button>` : ''}
        ${forecast?.error ? `<p class="row-error">${escapeHtml(forecast.error)}</p>` : ''}
      </th>
      ${dates.map((date) => forecastCell(forecast, date)).join('')}
    </tr>`;
  }).join('');
  if (active?.id && active.action) $('#mountain-list').querySelector(`[data-action="${CSS.escape(active.action)}"][data-id="${CSS.escape(active.id)}"]`)?.focus({ preventScroll: true });
}

async function loadForecast(mountain, force = false) {
  controllers.get(mountain.id)?.abort();
  const controller = new AbortController();
  controllers.set(mountain.id, controller);
  const dates = [...weekend.dates];
  const key = forecastCacheKey(mountain, dates);
  let cached = null;
  try { cached = readCachedForecast(localStorage, key, dates); } catch { /* An unusable cache is replaced by a network result. */ }
  if (cached && isFresh(cached.fetchedAt) && !force) {
    forecasts.set(mountain.id, cached);
    controllers.delete(mountain.id);
    render();
    return;
  }
  const previous = cached ?? forecasts.get(mountain.id);
  forecasts.set(mountain.id, { ...previous, loading: true, error: null });
  render();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const result = await fetchForecast(mountain, dates, controller.signal);
    if (controllers.get(mountain.id) !== controller) return;
    forecasts.set(mountain.id, result);
    try {
      // Only keep this mountain's current weekend, plus other favorites' entries.
      const validKeys = new Set(mountains.map((m) => forecastCacheKey(m, weekend.dates)));
      for (const storedKey of Object.keys(localStorage)) if (storedKey.startsWith('yamabiyori.forecast.') && !validKeys.has(storedKey)) localStorage.removeItem(storedKey);
      localStorage.setItem(key, JSON.stringify(result));
    } catch { /* Forecasts remain usable in memory if browser storage is full. */ }
  } catch (error) {
    if (controllers.get(mountain.id) !== controller) return;
    const message = controller.signal.aborted ? '取得がタイムアウトしました。再取得してください。' : error instanceof TypeError ? '予報を取得できませんでした。通信状態を確認して再取得してください。' : error.message;
    forecasts.set(mountain.id, { ...previous, loading: false, error: message });
  } finally {
    clearTimeout(timeout);
    if (controllers.get(mountain.id) === controller) {
      controllers.delete(mountain.id);
      render();
    }
  }
}

function openEditor(id = null) {
  if (!id && mountains.length >= MAX_MOUNTAINS) return;
  editingId = id;
  const mountain = mountains.find((m) => m.id === id);
  const form = $('#mountain-form');
  form.reset();
  for (const name of ['name', 'latitude', 'longitude', 'elevationM']) {
    form.elements[name].value = mountain ? mountain[name] : '';
  }
  $('#dialog-title').textContent = mountain ? '山を編集' : '山を追加';
  $('#delete-mountain').hidden = !mountain;
  $('#form-error').hidden = true;
  $('#mountain-dialog').showModal();
}

$('#add-mountain').addEventListener('click', () => openEditor());
$('#empty-add').addEventListener('click', () => openEditor());
$('#close-dialog').addEventListener('click', () => $('#mountain-dialog').close());
$('#mountain-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (button.dataset.action === 'edit') openEditor(button.dataset.id);
  else {
    const mountain = mountains.find((m) => m.id === button.dataset.id);
    if (mountain) loadForecast(mountain, true);
  }
});
$('#mountain-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const mountain = { id: editingId ?? crypto.randomUUID(), name: form.elements.name.value.trim(), latitude: form.elements.latitude.valueAsNumber, longitude: form.elements.longitude.valueAsNumber, elevationM: form.elements.elevationM.valueAsNumber };
  const error = validateMountain(mountain) ?? (!editingId && mountains.length >= MAX_MOUNTAINS ? '登録できる山は最大5件です。' : null);
  if (error) { $('#form-error').textContent = error; $('#form-error').hidden = false; return; }
  const previous = mountains.find((m) => m.id === editingId);
  if (previous) mountains = mountains.map((m) => m.id === editingId ? mountain : m);
  else mountains.push(mountain);
  saveMountains();
  $('#mountain-dialog').close();
  if (!previous || forecastCacheKey(previous, weekend.dates) !== forecastCacheKey(mountain, weekend.dates)) {
    forecasts.delete(mountain.id);
    loadForecast(mountain);
  } else render();
});
$('#delete-mountain').addEventListener('click', () => {
  controllers.get(editingId)?.abort();
  controllers.delete(editingId);
  forecasts.delete(editingId);
  mountains = mountains.filter((m) => m.id !== editingId);
  saveMountains();
  $('#mountain-dialog').close();
  render();
  $('#add-mountain').focus();
});
for (const [index, id] of ['#saturday-tab', '#sunday-tab'].entries()) $(id).addEventListener('click', () => { selectedDate = weekend.dates[index]; render(); });
$('#refresh').addEventListener('click', () => mountains.forEach((mountain) => loadForecast(mountain, true)));

function syncClock() {
  const nextWeekend = getWeekend();
  if (nextWeekend.dates[0] !== weekend.dates[0]) {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    forecasts.clear();
    weekend = nextWeekend;
    selectedDate = nextWeekend.selectedDate;
    mountains.forEach((mountain) => loadForecast(mountain));
  }
  render();
}
setInterval(syncClock, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncClock(); });
render();
mountains.forEach((mountain) => loadForecast(mountain));
