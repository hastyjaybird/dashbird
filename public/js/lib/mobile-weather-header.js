/**
 * Mobile topbar: centered current-weather chip combining location (City, ST)
 * with the current temperature + short condition. Tapping opens a popup with
 * today's high/low, wind, and feels-like detail.
 * Reuses the shared hero weather source (/api/hero-weather via weather-data.js)
 * and the device-location place (live GPS when allowed, else dashboard default).
 */
import { describeWeather, fetchCurrentWeather } from '../panels/weather-data.js';
import { subscribeDevicePlace } from './device-location.js';

const POLL_MS = 10 * 60 * 1000;

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

/** @type {HTMLElement | null} */
let mountEl = null;

/** @type {HTMLElement | null} */
let tempEl = null;

/** @type {HTMLElement | null} */
let descEl = null;

/** @type {HTMLElement | null} */
let glyphEl = null;

/** @type {HTMLElement | null} */
let locEl = null;

/** @type {{ lat: number, lon: number } | null} */
let coords = null;

/** @type {string} */
let placeLabel = '';

/** @type {boolean} */
let placeLive = false;

/** @type {Awaited<ReturnType<typeof fetchCurrentWeather>> | null} */
let latestWeather = null;

/** @type {HTMLElement | null} */
let popupBackdrop = null;

/** @type {((e: KeyboardEvent) => void) | null} */
let popupKeyHandler = null;

/**
 * Small emoji glyph from WMO weather code.
 * @param {number} code
 */
function weatherGlyph(code) {
  if (code === 0 || code === 1) return '\u2600\uFE0F';
  if (code === 2) return '\u26C5';
  if (code === 3) return '\u2601\uFE0F';
  if (code === 45 || code === 48) return '\uD83C\uDF2B\uFE0F';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '\uD83C\uDF27\uFE0F';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '\uD83C\uDF28\uFE0F';
  if (code >= 95) return '\u26C8\uFE0F';
  return '\uD83C\uDF21\uFE0F';
}

/**
 * @param {number | null | undefined} deg
 * @returns {string}
 */
function windCompass(deg) {
  if (!Number.isFinite(Number(deg))) return '';
  const d = ((Number(deg) % 360) + 360) % 360;
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return labels[Math.round(d / 45) % 8];
}

function friendlyPlace() {
  const p = (placeLabel || '').trim();
  if (p && p !== 'Locating\u2026') return p;
  return 'Weather';
}

function renderChip() {
  if (!mountEl) return;
  const hasPlace = Boolean(coords);
  if (!hasPlace && !latestWeather) {
    mountEl.hidden = true;
    return;
  }
  mountEl.hidden = false;

  if (locEl) locEl.textContent = (placeLabel || 'Locating\u2026').trim() || 'Locating\u2026';

  if (latestWeather) {
    if (tempEl) tempEl.textContent = `${Math.round(latestWeather.tempF)}\u00B0`;
    if (descEl) descEl.textContent = describeWeather(latestWeather.code);
    if (glyphEl) glyphEl.textContent = weatherGlyph(Number(latestWeather.code) || 0);
    const hi = latestWeather.highF != null ? `${Math.round(latestWeather.highF)}\u00B0` : '';
    const lo = latestWeather.lowF != null ? `${Math.round(latestWeather.lowF)}\u00B0` : '';
    const hilo = hi && lo ? ` \u00B7 H ${hi} / L ${lo}` : '';
    mountEl.title = `${friendlyPlace()} \u00B7 ${Math.round(latestWeather.tempF)}\u00B0F \u00B7 ${describeWeather(latestWeather.code)}${hilo}`;
  } else {
    if (tempEl) tempEl.textContent = '\u2026';
    if (descEl) descEl.textContent = '';
    if (glyphEl) glyphEl.textContent = '\uD83C\uDF21\uFE0F';
    mountEl.title = friendlyPlace();
  }
}

async function refreshWeather() {
  if (!coords) return;
  try {
    latestWeather = await fetchCurrentWeather(coords.lat, coords.lon);
    renderChip();
    if (popupBackdrop) renderPopupBody();
  } catch {
    /* keep last snapshot */
  }
}

function closePopup() {
  if (popupKeyHandler) {
    document.removeEventListener('keydown', popupKeyHandler);
    popupKeyHandler = null;
  }
  popupBackdrop?.remove();
  popupBackdrop = null;
  mountEl?.setAttribute('aria-expanded', 'false');
}

function renderPopupBody() {
  if (!popupBackdrop) return;
  const body = popupBackdrop.querySelector('.mobile-alert-header__body');
  const title = popupBackdrop.querySelector('.mobile-alert-header__title');
  const glyph = popupBackdrop.querySelector('.mobile-alert-header__head-glyph');
  if (!body) return;

  if (title) title.textContent = friendlyPlace();
  if (glyph && latestWeather) glyph.textContent = weatherGlyph(Number(latestWeather.code) || 0);

  /** @type {string[]} */
  const lines = [];
  const w = latestWeather;
  if (w) {
    lines.push(`${Math.round(w.tempF)}\u00B0F \u00B7 ${describeWeather(w.code)}`);
    if (w.apparentF != null && Math.round(w.apparentF) !== Math.round(w.tempF)) {
      lines.push(`Feels like ${Math.round(w.apparentF)}\u00B0F`);
    }
    if (w.highF != null || w.lowF != null) {
      const hi = w.highF != null ? `${Math.round(w.highF)}\u00B0` : '\u2014';
      const lo = w.lowF != null ? `${Math.round(w.lowF)}\u00B0` : '\u2014';
      lines.push(`High ${hi} \u00B7 Low ${lo}`);
    }
    if (w.windMph != null) {
      const dir = windCompass(w.windDirectionFromDeg);
      lines.push(`Wind ${Math.round(w.windMph)} mph${dir ? ` ${dir}` : ''}`);
    }
    if (placeLive) lines.push('Live GPS location.');
  } else {
    lines.push('Loading current conditions\u2026');
  }

  body.replaceChildren();
  for (const line of lines) {
    const p = document.createElement('p');
    p.className = 'mobile-alert-header__line';
    p.textContent = line;
    body.append(p);
  }
}

function openPopup() {
  if (!coords && !latestWeather) return;
  closePopup();

  const backdrop = document.createElement('div');
  backdrop.className = 'mobile-alert-header__backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closePopup();
  });

  const shell = document.createElement('div');
  shell.className = 'mobile-alert-header__dialog';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-label', `Weather for ${friendlyPlace()}`);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mobile-alert-header__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
  closeBtn.addEventListener('click', closePopup);

  const head = document.createElement('div');
  head.className = 'mobile-alert-header__head';
  const glyph = document.createElement('span');
  glyph.className = 'mobile-alert-header__head-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = latestWeather ? weatherGlyph(Number(latestWeather.code) || 0) : '\uD83C\uDF21\uFE0F';
  const title = document.createElement('div');
  title.className = 'mobile-alert-header__title';
  title.textContent = friendlyPlace();
  head.append(glyph, title);

  const body = document.createElement('div');
  body.className = 'mobile-alert-header__body';

  shell.append(closeBtn, head, body);
  backdrop.append(shell);
  document.body.append(backdrop);
  popupBackdrop = backdrop;
  mountEl?.setAttribute('aria-expanded', 'true');

  renderPopupBody();
  if (coords) void refreshWeather();

  popupKeyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopup();
    }
  };
  document.addEventListener('keydown', popupKeyHandler);
}

/**
 * @param {import('./device-location.js').DevicePlace} place
 */
function onPlaceChange(place) {
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;
  const changed = !coords || coords.lat !== place.lat || coords.lon !== place.lon;
  coords = { lat: place.lat, lon: place.lon };
  placeLabel = typeof place.shortLabel === 'string' ? place.shortLabel : placeLabel;
  placeLive = place.source === 'device';
  renderChip();
  if (changed) void refreshWeather();
}

/**
 * @param {HTMLElement | null} root
 */
export function mountMobileWeatherHeader(root) {
  if (!root) return;
  mountEl = root;
  mountEl.hidden = true;
  mountEl.className = 'topbar__weather mobile-weather-header';
  mountEl.setAttribute('role', 'button');
  mountEl.setAttribute('tabindex', '0');
  mountEl.setAttribute('aria-expanded', 'false');
  mountEl.replaceChildren();

  glyphEl = document.createElement('span');
  glyphEl.className = 'mobile-weather-header__glyph';
  glyphEl.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'mobile-weather-header__text';
  tempEl = document.createElement('span');
  tempEl.className = 'mobile-weather-header__temp';
  descEl = document.createElement('span');
  descEl.className = 'mobile-weather-header__desc';
  locEl = document.createElement('span');
  locEl.className = 'mobile-weather-header__loc';
  text.append(tempEl, descEl, locEl);

  mountEl.append(glyphEl, text);

  mountEl.addEventListener('click', () => {
    if (popupBackdrop) closePopup();
    else openPopup();
  });
  mountEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (popupBackdrop) closePopup();
      else openPopup();
    }
  });

  subscribeDevicePlace(onPlaceChange);
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      void refreshWeather();
    }, POLL_MS);
  }
}
