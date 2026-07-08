import { isPageVisible, setVisibleInterval } from '../lib/page-visibility.js';

const FEED_REFRESH_MS = 10 * 60 * 1000;
const FRAME_MS = 450;

/**
 * @param {string} host
 * @param {string} path
 * @param {number} tileSize
 * @param {{ x: number, y: number, z: number }} tile
 */
function rainViewerTileUrl(host, path, tileSize, tile) {
  return `${host}${path}/${tileSize}/${tile.z}/${tile.x}/${tile.y}/2/1_1.png`;
}

/**
 * @param {{ x: number, y: number, z: number }} tile
 */
function basemapTileUrl(tile) {
  return `https://tile.openstreetmap.org/${tile.z}/${tile.x}/${tile.y}.png`;
}

/**
 * @param {HTMLElement} hostEl
 * @param {object} data
 * @returns {() => void}
 */
function mountRainViewerTiles(hostEl, data) {
  const radar = data.radar;
  const frames = Array.isArray(radar?.frames) ? radar.frames : [];
  const tiles = Array.isArray(radar?.tiles) ? radar.tiles : [];
  const host = typeof radar?.host === 'string' ? radar.host : '';
  const tileSize = Number(radar?.tileSize) || 256;
  const grid = Number(radar?.grid) || 1;
  const cropScale = Number(radar?.cropScale);
  const crop =
    Number.isFinite(cropScale) && cropScale > 1.02 ? cropScale : 1;
  const fx = Number(radar?.center?.fx);
  const fy = Number(radar?.center?.fy);
  const originX = Number.isFinite(fx) ? `${fx * 100}%` : '50%';
  const originY = Number.isFinite(fy) ? `${fy * 100}%` : '50%';

  if (!host || !frames.length || !tiles.length) {
    return () => {};
  }

  const wrap = document.createElement('div');
  wrap.className = 'weather-radar__tile-grid';
  wrap.style.setProperty('--rv-cols', String(grid));
  wrap.style.setProperty('--rv-crop-scale', String(crop));
  wrap.style.setProperty('--rv-origin-x', originX);
  wrap.style.setProperty('--rv-origin-y', originY);

  /** @type {HTMLImageElement[]} */
  const imgs = [];
  for (const tile of tiles) {
    const cell = document.createElement('div');
    cell.className = 'weather-radar__tile-cell';
    const basemap = document.createElement('img');
    basemap.className = 'weather-radar__basemap-img';
    basemap.alt = '';
    basemap.decoding = 'async';
    basemap.loading = 'lazy';
    basemap.referrerPolicy = 'no-referrer';
    basemap.src = basemapTileUrl(tile);
    const img = document.createElement('img');
    img.className = 'weather-radar__tile-img';
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    cell.append(basemap, img);
    wrap.append(cell);
    imgs.push(img);
  }

  hostEl.replaceChildren(wrap);

  let frameIndex = frames.length - 1;
  let animTimer = null;

  const paintFrame = () => {
    if (!isPageVisible()) return;
    const frame = frames[frameIndex];
    if (!frame?.path) return;
    tiles.forEach((tile, i) => {
      const img = imgs[i];
      if (!img) return;
      const next = rainViewerTileUrl(host, frame.path, tileSize, tile);
      if (img.src !== next) img.src = next;
    });
    frameIndex = (frameIndex + 1) % frames.length;
  };

  const startAnim = () => {
    if (animTimer) return;
    paintFrame();
    animTimer = setInterval(paintFrame, FRAME_MS);
  };

  const stopAnim = () => {
    if (animTimer) {
      clearInterval(animTimer);
      animTimer = null;
    }
  };

  const io = new IntersectionObserver(
    (entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible) startAnim();
      else stopAnim();
    },
    { rootMargin: '40px' },
  );
  io.observe(wrap);

  return () => {
    stopAnim();
    io.disconnect();
  };
}

/**
 * @param {HTMLElement} hostEl
 * @param {object} data
 */
function applyLinkFallback(hostEl, data) {
  const href =
    typeof data.embed?.mapPageUrl === 'string' ? data.embed.mapPageUrl : 'https://www.rainviewer.com/';
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
 * @param {HTMLElement} cap
 * @param {object} data
 */
function applyCaption(cap, data) {
  const msg = typeof data.message === 'string' ? data.message.trim() : '';
  const href =
    typeof data.embed?.mapPageUrl === 'string' && /^https?:\/\//i.test(data.embed.mapPageUrl)
      ? data.embed.mapPageUrl
      : 'https://www.rainviewer.com/';
  cap.replaceChildren();
  if (msg) cap.append(document.createTextNode(`${msg} · `));
  const link = document.createElement('a');
  link.className = 'weather-radar__map-link';
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'RainViewer ↗';
  cap.append(link);
  cap.append(document.createTextNode(' · Map © OpenStreetMap'));
  cap.hidden = false;
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

  const cap = document.createElement('p');
  cap.className = 'weather-radar__caption';
  cap.hidden = true;
  mount.append(cap);

  let stopTiles = () => {};
  let stopPoll = () => {};

  async function refresh() {
    try {
      const r = await fetch('/api/weather-radar', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }

      if (!data.show) {
        card.hidden = true;
        stopTiles();
        stopTiles = () => {};
        body.replaceChildren();
        cap.hidden = true;
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

      const radiusMi = Number(data.radar?.radiusMi) || Number(data.embed?.radiusMi) || 5;
      const msg = typeof data.message === 'string' ? data.message.trim() : '';
      const radiusNote = `${radiusMi} mi radius from dashboard ZIP`;
      mapHost.setAttribute(
        'aria-label',
        msg ? `${msg} — RainViewer radar, ${radiusNote}` : `Animated precipitation radar, ${radiusNote}`,
      );

      stopTiles();
      stopTiles = () => {};

      if (data.provider === 'rainviewer' && data.radar) {
        stopTiles = mountRainViewerTiles(mapHost, data);
      } else {
        applyLinkFallback(mapHost, data);
      }

      applyCaption(cap, data);
    } catch {
      card.hidden = true;
      status.hidden = true;
      stopTiles();
      stopTiles = () => {};
      body.replaceChildren();
      cap.hidden = true;
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

  return () => {
    io.disconnect();
    stopPoll();
    stopTiles();
  };
}
