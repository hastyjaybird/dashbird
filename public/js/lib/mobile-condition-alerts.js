/**
 * Mobile topbar: condition alert icons (volcano, geomagnetic storm / aurora,
 * air quality, rain). Each icon only appears when that condition is active,
 * mirroring the aircraft-alert pattern. Tapping opens a small popup with details.
 * Reuses existing endpoints only — no new backends.
 */
import { describeWeather, fetchCurrentWeather } from '../panels/weather-data.js';
import { subscribeDevicePlace } from './device-location.js';

const POLL_MS = 5 * 60 * 1000;

/** Rain-ish WMO codes (drizzle, rain, freezing rain, showers, thunderstorm). */
const RAIN_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99,
]);

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

/** @type {HTMLElement | null} */
let mountEl = null;

/** @type {{ lat: number, lon: number } | null} */
let coords = null;

/** @type {HTMLElement | null} */
let popupBackdrop = null;

/** @type {((e: KeyboardEvent) => void) | null} */
let popupKeyHandler = null;

/** @type {ReturnType<typeof setInterval> | null} */
let popupMediaTimer = null;

/**
 * @typedef {{ kind: 'image', src: string, alt?: string }
 *   | { kind: 'iframe', src: string, title?: string }
 *   | { kind: 'frames', urls: string[], frameMs?: number, alt?: string }} AlertMedia
 * @typedef {{ active: boolean, title: string, lines: string[], media?: AlertMedia | null }} AlertState
 * @typedef {{ key: string, glyph: string, label: string, load: () => Promise<AlertState>,
 *   btn: HTMLButtonElement | null, state: AlertState }} AlertDef
 */

/** @type {AlertDef[]} */
const ALERTS = [
  { key: 'volcano', glyph: '\uD83C\uDF0B', label: 'Volcano', load: loadVolcano, btn: null, state: idle() },
  { key: 'geomag', glyph: '\uD83C\uDF0C', label: 'Geomagnetic storm', load: loadGeomag, btn: null, state: idle() },
  { key: 'air', glyph: '\uD83D\uDE37', label: 'Air quality', load: loadAir, btn: null, state: idle() },
  { key: 'rain', glyph: '\uD83C\uDF27\uFE0F', label: 'Rain', load: loadRain, btn: null, state: idle() },
];

/** @returns {AlertState} */
function idle() {
  return { active: false, title: '', lines: [], media: null };
}

async function loadVolcano() {
  try {
    const r = await fetch('/api/dashboard-kilauea', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    const s = j?.status || {};
    const alert = String(s.alertLevel || '').toUpperCase();
    const hasForecast = s.hasEruptionForecast === true;
    const active =
      s.erupting === true || (alert !== '' && alert !== 'NORMAL') || hasForecast;
    if (!active) return idle();
    const detail =
      Array.isArray(j.items) && j.items[0]?.detailLine ? String(j.items[0].detailLine) : '';
    const lines = [];
    if (s.erupting) lines.push('\u2757 K\u012Blauea is erupting.');
    else if (alert !== '' && alert !== 'NORMAL') lines.push('K\u012Blauea activity is elevated.');
    if (detail) lines.push(detail);
    else {
      const parts = [];
      if (s.alertLevel) parts.push(`Alert ${s.alertLevel}`);
      if (s.colorCode) parts.push(s.colorCode);
      if (s.episode != null) parts.push(`Episode ${s.episode}`);
      if (s.fountainFt != null) parts.push(`fountain ${s.fountainFt} ft`);
      if (parts.length) lines.push(parts.join(' \u00B7 '));
    }
    if (hasForecast && s.forecast) {
      lines.push(`\uD83D\uDCC5 Next eruption forecast: ${String(s.forecast)}`);
    }
    const cam = Array.isArray(j.cameras) ? j.cameras.find((c) => c?.embedUrl) : null;
    /** @type {AlertMedia} */
    const media = cam?.embedUrl
      ? { kind: 'iframe', src: String(cam.embedUrl), title: 'K\u012Blauea summit livestream' }
      : { kind: 'image', src: '/assets/earth-kilauea-volcano.png', alt: 'K\u012Blauea volcano' };
    // ! for erupting, calendar for a next-eruption forecast.
    const titleMarks = `${s.erupting ? '\u2757' : ''}${hasForecast ? '\uD83D\uDCC5' : ''}`;
    return {
      active: true,
      title: `K\u012Blauea volcano${titleMarks ? ` ${titleMarks}` : ''}`,
      lines,
      media,
    };
  } catch {
    return idle();
  }
}

async function loadGeomag() {
  try {
    const r = await fetch('/api/magnetosphere', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    const active = j?.stormGte2 === true || j?.stormActive === true;
    if (!active) return idle();
    const storm = j.storm || {};
    const lines = ['Geomagnetic storm active \u2014 aurora may be visible.'];
    if (storm.label) lines.push(String(storm.label));
    else {
      const parts = [];
      if (storm.g != null) parts.push(`G${storm.g}`);
      if (storm.kp != null) parts.push(`Kp ${storm.kp}`);
      if (storm.category) parts.push(String(storm.category));
      if (parts.length) lines.push(parts.join(' \u00B7 '));
    }
    const urls = Array.isArray(j.frames) ? j.frames.map((f) => f?.url).filter(Boolean) : [];
    /** @type {AlertMedia} */
    const media = urls.length
      ? { kind: 'frames', urls, frameMs: Number(j.frameMs) || 450, alt: 'Magnetosphere cut-plane animation' }
      : { kind: 'image', src: '/assets/sky/aurora.png', alt: 'Aurora' };
    return { active: true, title: 'Geomagnetic storm', lines, media };
  } catch {
    return idle();
  }
}

async function loadAir() {
  try {
    const r = await fetch('/api/air-quality', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (j?.disabled) return idle();
    const active = j?.aboveThreshold === true || (j?.show === true && j?.aboveThreshold !== false);
    if (!active) return idle();
    const aqi = j.usAqi != null ? Math.round(Number(j.usAqi)) : null;
    const lines = ['Air quality is elevated.'];
    const parts = [];
    if (aqi != null) parts.push(`US AQI ${aqi}`);
    if (j.category) parts.push(String(j.category));
    if (j.zip) parts.push(`ZIP ${j.zip}`);
    if (parts.length) lines.push(parts.join(' \u00B7 '));
    /** @type {AlertMedia | null} */
    const media =
      typeof j.mapUrl === 'string' && /^https?:\/\//i.test(j.mapUrl)
        ? { kind: 'iframe', src: j.mapUrl, title: 'Air quality map (PM2.5)' }
        : null;
    return { active: true, title: 'Air quality', lines, media };
  } catch {
    return idle();
  }
}

async function loadRain() {
  if (!coords) return idle();
  try {
    const w = await fetchCurrentWeather(coords.lat, coords.lon);
    const code = Number(w.code) || 0;
    if (!RAIN_CODES.has(code)) return idle();
    const lines = [
      `${describeWeather(code)} right now.`,
      `${Math.round(w.tempF)}\u00B0F${w.apparentF != null ? ` \u00B7 feels ${Math.round(w.apparentF)}\u00B0F` : ''}`,
    ];
    return { active: true, title: 'Rain', lines };
  } catch {
    return idle();
  }
}

function closePopup() {
  if (popupKeyHandler) {
    document.removeEventListener('keydown', popupKeyHandler);
    popupKeyHandler = null;
  }
  if (popupMediaTimer) {
    clearInterval(popupMediaTimer);
    popupMediaTimer = null;
  }
  popupBackdrop?.remove();
  popupBackdrop = null;
  for (const a of ALERTS) a.btn?.setAttribute('aria-expanded', 'false');
}

/**
 * Build the visual media element for a popup, if the alert has any.
 * Uses only assets/animations that already exist in the app.
 * @param {AlertMedia | null | undefined} media
 * @returns {HTMLElement | null}
 */
function buildMedia(media) {
  if (!media) return null;
  const wrap = document.createElement('div');
  wrap.className = 'mobile-alert-header__media';

  if (media.kind === 'iframe') {
    const iframe = document.createElement('iframe');
    iframe.className = 'mobile-alert-header__media-frame';
    iframe.src = media.src;
    iframe.title = media.title || 'Details';
    iframe.loading = 'lazy';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.setAttribute(
      'allow',
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen',
    );
    iframe.allowFullscreen = true;
    wrap.append(iframe);
    return wrap;
  }

  if (media.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'mobile-alert-header__media-img';
    img.src = media.src;
    img.alt = media.alt || '';
    img.decoding = 'async';
    img.loading = 'lazy';
    wrap.append(img);
    return wrap;
  }

  if (media.kind === 'frames' && media.urls.length) {
    const img = document.createElement('img');
    img.className = 'mobile-alert-header__media-img';
    img.alt = media.alt || '';
    img.decoding = 'async';
    const urls = media.urls;
    for (const url of urls) {
      const pre = new Image();
      pre.decoding = 'async';
      pre.src = url;
    }
    let idx = 0;
    img.src = urls[0];
    if (urls.length > 1) {
      if (popupMediaTimer) clearInterval(popupMediaTimer);
      popupMediaTimer = setInterval(() => {
        idx = (idx + 1) % urls.length;
        img.src = urls[idx];
      }, Number(media.frameMs) || 450);
    }
    wrap.append(img);
    return wrap;
  }

  return null;
}

/**
 * @param {AlertDef} alert
 */
function openPopup(alert) {
  if (!alert.state.active) return;
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
  shell.setAttribute('aria-label', alert.state.title || alert.label);

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
  glyph.textContent = alert.glyph;
  const title = document.createElement('div');
  title.className = 'mobile-alert-header__title';
  title.textContent = alert.state.title || alert.label;
  head.append(glyph, title);

  const media = buildMedia(alert.state.media);

  const body = document.createElement('div');
  body.className = 'mobile-alert-header__body';
  for (const line of alert.state.lines) {
    const p = document.createElement('p');
    p.className = 'mobile-alert-header__line';
    p.textContent = line;
    body.append(p);
  }

  if (media) shell.append(closeBtn, head, media, body);
  else shell.append(closeBtn, head, body);
  backdrop.append(shell);
  document.body.append(backdrop);
  popupBackdrop = backdrop;
  alert.btn?.setAttribute('aria-expanded', 'true');

  popupKeyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopup();
    }
  };
  document.addEventListener('keydown', popupKeyHandler);
}

/**
 * @param {AlertDef} alert
 */
function renderIcon(alert) {
  if (!alert.btn) return;
  const on = alert.state.active;
  alert.btn.hidden = !on;
  if (on) {
    alert.btn.title = alert.state.lines[0] || alert.state.title || alert.label;
    alert.btn.setAttribute('aria-label', `${alert.state.title || alert.label}: tap for details`);
  }
}

function syncMountVisibility() {
  if (!mountEl) return;
  mountEl.hidden = !ALERTS.some((a) => a.state.active);
}

async function refreshAlerts() {
  await Promise.all(
    ALERTS.map(async (alert) => {
      alert.state = await alert.load();
      renderIcon(alert);
    }),
  );
  if (popupBackdrop && !ALERTS.some((a) => a.state.active)) closePopup();
  syncMountVisibility();
}

/**
 * @param {import('./device-location.js').DevicePlace} place
 */
function onPlaceChange(place) {
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;
  coords = { lat: place.lat, lon: place.lon };
}

/**
 * @param {HTMLElement | null} root
 */
export function mountMobileConditionAlerts(root) {
  if (!root) return;
  mountEl = root;
  mountEl.hidden = true;
  mountEl.className = 'topbar__conditions mobile-alert-header';
  mountEl.replaceChildren();

  for (const alert of ALERTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mobile-alert-header__btn mobile-alert-header__btn--${alert.key}`;
    btn.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = alert.glyph;
    btn.append(glyph);
    btn.addEventListener('click', () => {
      if (popupBackdrop && popupBackdrop.dataset.key === alert.key) closePopup();
      else {
        openPopup(alert);
        if (popupBackdrop) popupBackdrop.dataset.key = alert.key;
      }
    });
    alert.btn = btn;
    mountEl.append(btn);
  }

  subscribeDevicePlace(onPlaceChange);
  void refreshAlerts();
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      void refreshAlerts();
    }, POLL_MS);
  }
}
