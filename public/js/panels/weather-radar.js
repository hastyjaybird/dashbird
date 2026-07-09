import { isPageVisible, setVisibleInterval } from '../lib/page-visibility.js';
import {
  devicePlaceQueryString,
  getDevicePlace,
  subscribeDevicePlace,
} from '../lib/device-location.js';

const FEED_REFRESH_MS = 10 * 60 * 1000;
const FRAME_MS = 700;

/** @type {Promise<any> | null} */
let leafletPromise = null;

function loadLeaflet() {
  if (leafletPromise) return leafletPromise;
  leafletPromise = (async () => {
    if (!document.querySelector('link[data-dashbird-leaflet]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/vendor/leaflet/leaflet.css';
      link.dataset.dashbirdLeaflet = '1';
      document.head.append(link);
    }
    if (/** @type {any} */ (window).L) return /** @type {any} */ (window).L;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/leaflet/leaflet.js';
      s.async = true;
      s.onload = () => resolve(undefined);
      s.onerror = () => reject(new Error('leaflet_load_failed'));
      document.head.append(s);
    });
    const L = /** @type {any} */ (window).L;
    if (!L) throw new Error('leaflet_missing');
    return L;
  })();
  return leafletPromise;
}

/**
 * @param {HTMLElement} hostEl
 * @param {object} data
 * @returns {() => void}
 */
function mountIemLeaflet(hostEl, data) {
  const radar = data.radar;
  const frames = Array.isArray(radar?.frames) ? radar.frames : [];
  if (!radar || !frames.length) {
    return () => {};
  }

  const wrap = document.createElement('div');
  wrap.className = 'weather-radar__map-wrap';

  const mapEl = document.createElement('div');
  mapEl.className = 'weather-radar__leaflet';

  const controls = document.createElement('div');
  controls.className = 'weather-radar__controls';
  controls.setAttribute('aria-hidden', 'true');

  const progress = document.createElement('div');
  progress.className = 'weather-radar__progress';
  const progressFill = document.createElement('div');
  progressFill.className = 'weather-radar__progress-fill';
  progress.append(progressFill);

  const timeEl = document.createElement('span');
  timeEl.className = 'weather-radar__time';

  controls.append(progress, timeEl);
  wrap.append(mapEl, controls);
  hostEl.replaceChildren(wrap);

  let map = null;
  let radarLayer = null;
  let marker = null;
  let frameIndex = frames.length - 1;
  let animTimer = null;
  let destroyed = false;
  /** @type {IntersectionObserver | null} */
  let io = null;

  const paintFrame = (idx) => {
    if (!map || !radarLayer || destroyed) return;
    const frame = frames[idx];
    if (!frame?.urlTemplate) return;
    radarLayer.setUrl(frame.urlTemplate);
    frameIndex = idx;
    const denom = Math.max(1, frames.length - 1);
    progressFill.style.width = `${(idx / denom) * 100}%`;
    timeEl.textContent = frame.label || '';
  };

  const stopAnim = () => {
    if (animTimer) {
      clearInterval(animTimer);
      animTimer = null;
    }
  };

  const startAnim = () => {
    if (animTimer || destroyed) return;
    animTimer = setInterval(() => {
      if (!isPageVisible()) return;
      const next = (frameIndex + 1) % frames.length;
      paintFrame(next);
    }, FRAME_MS);
  };

  loadLeaflet()
    .then((L) => {
      if (destroyed) return;
      const lat = Number(radar.lat);
      const lon = Number(radar.lon);
      const maxZoom = Number(radar.maxZoom) || 10;
      const minZoom = Number(radar.minZoom) || 5;
      const zoom = maxZoom;
      map = L.map(mapEl, {
        zoomControl: true,
        attributionControl: false,
        maxBoundsViscosity: 0.85,
      });

      const bm = radar.basemap || {};
      L.tileLayer(bm.url || 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '',
        subdomains: bm.subdomains || 'abcd',
        maxZoom,
        minZoom,
      }).addTo(map);

      const opacity = Number(radar.opacity);
      radarLayer = L.tileLayer(frames[frameIndex].urlTemplate, {
        opacity: Number.isFinite(opacity) ? opacity : 0.68,
        maxZoom,
        minZoom,
        zIndex: 200,
      }).addTo(map);

      if (Array.isArray(radar.maxBounds) && radar.maxBounds.length === 2) {
        map.setMaxBounds(radar.maxBounds);
      }
      map.setView([lat, lon], zoom);
      marker = L.circleMarker([lat, lon], {
        radius: 5,
        color: '#8eb8ff',
        weight: 2,
        fillColor: '#cfe0ff',
        fillOpacity: 0.85,
      }).addTo(map);

      paintFrame(frameIndex);
      requestAnimationFrame(() => {
        map?.invalidateSize();
        startAnim();
      });

      io = new IntersectionObserver(
        (entries) => {
          const visible = entries.some((e) => e.isIntersecting);
          if (visible) {
            map?.invalidateSize();
            startAnim();
          } else {
            stopAnim();
          }
        },
        { rootMargin: '40px' },
      );
      io.observe(wrap);
    })
    .catch(() => {
      if (destroyed) return;
      const p = document.createElement('p');
      p.className = 'weather-radar__link-fallback';
      p.textContent = 'Could not load map library.';
      hostEl.replaceChildren(p);
    });

  return () => {
    destroyed = true;
    stopAnim();
    if (io) io.disconnect();
    if (map) {
      map.remove();
      map = null;
    }
    radarLayer = null;
    marker = null;
  };
}

/**
 * @param {HTMLElement} hostEl
 * @param {object} data
 */
function applyLinkFallback(hostEl, data) {
  const href =
    typeof data.embed?.mapPageUrl === 'string'
      ? data.embed.mapPageUrl
      : 'https://radar.weather.gov/';
  const p = document.createElement('p');
  p.className = 'weather-radar__link-fallback';
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Open live radar map ↗';
  p.append(a);
  hostEl.replaceChildren(p);
}

/**
 * @param {HTMLElement | null} card
 * @param {HTMLElement | null} mount
 */
export function mountWeatherRadar(card, mount) {
  if (!mount || !card) return;

  const body = document.createElement('div');
  body.className = 'weather-radar__body';
  mount.append(body);

  const status = document.createElement('p');
  status.className = 'weather-radar__status';
  status.hidden = true;
  mount.append(status);

  let stopMap = () => {};
  let stopPoll = () => {};
  /** @type {string} */
  let lastPlaceKey = '';
  /** @type {string} */
  let lastMountKey = '';

  async function refresh() {
    try {
      const qs = devicePlaceQueryString({ includeLabel: true });
      const r = await fetch(`/api/weather-radar${qs}`, { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }

      if (!data.show) {
        card.hidden = true;
        stopMap();
        stopMap = () => {};
        lastMountKey = '';
        body.replaceChildren();
        status.hidden = true;
        return;
      }

      card.hidden = false;
      status.hidden = true;

      let mapHost = body.querySelector('.weather-radar__map-host');
      if (!mapHost) {
        mapHost = document.createElement('div');
        mapHost.className = 'weather-radar__map-host';
        body.prepend(mapHost);
      }

      const place =
        typeof data.geo?.displayName === 'string' ? data.geo.displayName : 'device location';
      mapHost.setAttribute('aria-label', `Animated precipitation radar near ${place}`);

      if (Number.isFinite(Number(data.radar?.lat)) && Number.isFinite(Number(data.radar?.lon))) {
        lastPlaceKey = `${Number(data.radar.lat).toFixed(3)},${Number(data.radar.lon).toFixed(3)}`;
      }

      const firstFrame = data.radar?.frames?.[0]?.id || '';
      const lastFrame = data.radar?.frames?.[data.radar.frames.length - 1]?.id || '';
      const mountKey = `${lastPlaceKey}|${firstFrame}|${lastFrame}|${data.provider}`;
      if (mountKey !== lastMountKey || !mapHost.querySelector('.weather-radar__map-wrap')) {
        stopMap();
        stopMap = () => {};
        lastMountKey = mountKey;
        if (data.provider === 'iem' && data.radar) {
          stopMap = mountIemLeaflet(mapHost, data);
        } else {
          applyLinkFallback(mapHost, data);
        }
      }
    } catch (e) {
      card.hidden = false;
      stopMap();
      stopMap = () => {};
      lastMountKey = '';
      body.replaceChildren();
      status.hidden = false;
      status.textContent =
        e instanceof Error ? `Radar unavailable: ${e.message}` : 'Radar unavailable';
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) refresh();
    },
    { rootMargin: '80px' },
  );
  io.observe(card);

  stopPoll = setVisibleInterval(refresh, FEED_REFRESH_MS);

  const unsubPlace = subscribeDevicePlace(() => {
    const p = getDevicePlace();
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
    if (key !== lastPlaceKey) refresh();
  });

  refresh();

  return () => {
    io.disconnect();
    stopPoll();
    stopMap();
    unsubPlace();
  };
}
