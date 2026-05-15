import { createPolygonWeatherIcon } from './weather-polygon.js';
import { createMoonPhaseGlyph } from '../lib/moon-phase.js';
import {
  describeWeather,
  fetchCurrentWeather,
  fetchAstronomyForHero,
} from './weather-data.js';

const TZ = 'America/Los_Angeles';

const HERO_SUNSET_SRC = '/icons/weather/sunset-glyph.png';

/** Phase-accurate moon disc (SVG — no external strip asset). */
function buildHeroMoonGlyph(date) {
  const wrap = createMoonPhaseGlyph(date);
  wrap.classList.add(
    'hero-astro-glyph--img',
    'hero-round-astro-icon',
    'hero-moon-phases-icon',
  );
  return wrap;
}

function buildHeroSunsetGlyph() {
  const wrap = document.createElement('span');
  wrap.className =
    'hero-astro-glyph hero-astro-glyph--img hero-round-astro-icon hero-sunset-glyph';
  const img = document.createElement('img');
  img.src = HERO_SUNSET_SRC;
  img.alt = 'Sunset';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function formatTime12h(d) {
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDateLong(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function formatSunsetLabel(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TZ,
  });
}

/** Next moonrise: local time only (no weekday). */
function formatMoonriseLabel(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const timeStr = (
    d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: TZ,
    }) || ''
  ).trim();
  return timeStr || '—';
}

function windTowardDeg(fromDeg) {
  if (typeof fromDeg !== 'number' || Number.isNaN(fromDeg)) return null;
  return ((fromDeg + 180) % 360 + 360) % 360;
}

function cardinalFromDeg(fromDeg) {
  if (typeof fromDeg !== 'number' || Number.isNaN(fromDeg)) return '';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const i = Math.round(fromDeg / 45) % 8;
  return dirs[i];
}

function createWindDisplay(towardDeg, windMph, fromDeg) {
  const wrap = document.createElement('span');
  wrap.className = 'hero-wind-wrap';

  const mph = windMph != null ? Math.round(windMph) : null;
  const fromCard = cardinalFromDeg(fromDeg);
  const titleParts = [];
  if (mph != null) titleParts.push(`${mph} mph`);
  if (fromCard) titleParts.push(`from ${fromCard}`);
  if (titleParts.length) {
    const t = titleParts.join(' · ');
    wrap.title = t;
    wrap.setAttribute('aria-label', `Wind, ${t}`);
  }

  if (towardDeg != null) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'hero-wind-arrow');
    svg.setAttribute('viewBox', '-12 -12 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.transform = `rotate(${towardDeg}deg)`;
    svg.style.transformOrigin = 'center';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M 0,-8 L 5.5,7 L 0,3 L -5.5,7 Z');
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    wrap.appendChild(svg);
  }

  if (mph != null) {
    const mphEl = document.createElement('span');
    mphEl.className = 'hero-wind-mph';
    mphEl.textContent = `${mph} mph`;
    wrap.appendChild(mphEl);
  }

  return wrap;
}

function buildCityBlock(cityLabel) {
  const col = document.createElement('div');
  col.className = 'hero-city';

  const lab = document.createElement('div');
  lab.className = 'hero-city-label';
  lab.textContent = cityLabel;

  const body = document.createElement('div');
  body.className = 'hero-city-body';

  const row = document.createElement('div');
  row.className = 'hero-temp-row';

  const tempEl = document.createElement('div');
  tempEl.className = 'hero-temp';
  tempEl.textContent = '—';

  const iconSlot = document.createElement('div');
  iconSlot.className = 'hero-icon-slot';

  row.append(tempEl, iconSlot);

  const descEl = document.createElement('div');
  descEl.className = 'hero-weather-desc';

  const metaEl = document.createElement('div');
  metaEl.className = 'hero-weather-meta';

  body.append(row, descEl, metaEl);
  col.append(lab, body);

  return { col, tempEl, iconSlot, descEl, metaEl };
}

function fillCityWeather({ tempEl, iconSlot, descEl, metaEl }, w, idSuffix) {
  const t = Math.round(w.tempF);
  tempEl.textContent = `${t}°`;
  const feel = w.apparentF != null ? Math.round(w.apparentF) : t;
  const label = describeWeather(w.code);
  descEl.textContent = `${label} · feels like ${feel}°`;

  metaEl.replaceChildren();
  const toward = windTowardDeg(w.windDirectionFromDeg);
  if (toward != null || w.windMph != null) {
    metaEl.appendChild(createWindDisplay(toward, w.windMph, w.windDirectionFromDeg));
  }

  iconSlot.replaceChildren(createPolygonWeatherIcon(w.code, idSuffix));
}

/**
 * @param {string} [linkHref] If set (https? only), row is an external link (e.g. ISS → Spot the Station).
 */
function buildAstroItem(glyphEl, title, timeText, linkHref) {
  const href =
    typeof linkHref === 'string' && /^https?:\/\//i.test(linkHref.trim())
      ? linkHref.trim()
      : '';
  const item = href ? document.createElement('a') : document.createElement('div');
  item.className = href ? 'hero-astro-item hero-astro-item--link' : 'hero-astro-item';
  if (href) {
    item.href = href;
    item.target = '_blank';
    item.rel = 'noopener noreferrer';
  }
  const g = document.createElement('div');
  g.className = 'hero-astro-glyph-wrap';
  g.appendChild(glyphEl);
  const text = document.createElement('div');
  text.className = 'hero-astro-text';
  const t1 = document.createElement('span');
  t1.className = 'hero-astro-title';
  t1.textContent = title;
  text.appendChild(t1);
  if (timeText != null && String(timeText).trim() !== '') {
    const t2 = document.createElement('strong');
    t2.className = 'hero-astro-time';
    t2.textContent = timeText;
    text.appendChild(t2);
  }
  item.append(g, text);
  return item;
}

function formatSkyEventLine(startIso, endIso, peakIso, now = new Date()) {
  const nowMs = now.getTime();
  const s = new Date(startIso);
  if (Number.isNaN(s.getTime())) return '—';
  const sMs = s.getTime();

  const e = endIso != null && endIso !== '' ? new Date(endIso) : null;
  const eMs = e && !Number.isNaN(e.getTime()) ? e.getTime() : null;

  const p = peakIso != null && peakIso !== '' ? new Date(peakIso) : null;
  const pMs = p && !Number.isNaN(p.getTime()) ? p.getTime() : null;

  if (pMs != null && nowMs < pMs) {
    const d = p.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: TZ,
    });
    const t = p.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: TZ,
    });
    return `${d} · ${t} (peak)`;
  }

  if (eMs != null && eMs > sMs && nowMs >= sMs) {
    const d2 = e.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: TZ,
    });
    const t2 = e.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: TZ,
    });
    return `Until ${d2} · ${t2}`;
  }

  const d1 = s.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: TZ,
  });
  const t1 = s.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TZ,
  });
  if (eMs == null || eMs === sMs) return `${d1} · ${t1}`;
  const d1c = s.toLocaleDateString('en-CA', { timeZone: TZ });
  const d2c = e.toLocaleDateString('en-CA', { timeZone: TZ });
  const t2 = e.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TZ,
  });
  if (d1c === d2c) return `${d1} · ${t1} – ${t2}`;
  const d2 = e.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: TZ,
  });
  return `${d1} ${t1} → ${d2} ${t2}`;
}

function buildSkyEventGlyph(iconSrc, eventType) {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img';
  if (eventType === 'aurora') wrap.classList.add('hero-astro-glyph--aurora');
  if (!iconSrc) {
    wrap.textContent = '◆';
    wrap.setAttribute('aria-hidden', 'true');
    return wrap;
  }
  const img = document.createElement('img');
  img.src = iconSrc;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function fillSkyEventStrip(container) {
  container.className = 'hero-astro-middle';
  container.setAttribute('aria-label', 'Sky and space events in the next day');
  fetch('/api/sky-events?windowHours=24', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      container.replaceChildren();
      if (!j?.ok || !Array.isArray(j.active)) return;
      if (j.active.length === 0) {
        const p = document.createElement('p');
        p.className = 'hero-sky-empty';
        p.textContent = 'No sky events in the next 24 hours.';
        container.appendChild(p);
        return;
      }
      const max = 6;
      for (let i = 0; i < Math.min(j.active.length, max); i++) {
        const ev = j.active[i];
        const meta = ev.typeMeta || {};
        const glyph = buildSkyEventGlyph(meta.icon, ev.type);
        const shortTitle = (meta.label || '').trim() || ev.title || 'Event';
        let line = null;
        if (ev.type === 'supermoon') {
          line = null;
        } else if (typeof ev.detailLine === 'string' && ev.detailLine.trim() !== '') {
          line = ev.detailLine.trim();
        } else {
          line = formatSkyEventLine(ev.startsAt, ev.endsAt, ev.peakAt, new Date());
        }
        const linkHref = typeof meta.forecastUrl === 'string' ? meta.forecastUrl : '';
        const item = buildAstroItem(glyph, shortTitle, line, linkHref);
        if (ev.source) item.title = ev.source;
        else if (linkHref) item.title = 'Open sighting forecast (new tab)';
        container.appendChild(item);
      }
    })
    .catch(() => {
      container.replaceChildren();
    });
}

export function mountHero(root, config) {
  root.replaceChildren();

  const cluster = document.createElement('div');
  cluster.className = 'hero-cluster';

  const timeCol = document.createElement('div');
  timeCol.className = 'hero-col hero-col--time';

  const clockEl = document.createElement('div');
  clockEl.className = 'hero-clock';
  const dateEl = document.createElement('div');
  dateEl.className = 'hero-date';

  timeCol.append(clockEl, dateEl);

  const citiesWrap = document.createElement('div');
  citiesWrap.className = 'hero-cities';

  const oak = buildCityBlock('Oakland');
  const sep = document.createElement('div');
  sep.className = 'hero-cities-sep';
  sep.setAttribute('role', 'presentation');
  const sf = buildCityBlock('San Francisco');

  citiesWrap.append(oak.col, sep, sf.col);

  const astro = document.createElement('div');
  astro.className = 'hero-astro';

  const astroInner = document.createElement('div');
  astroInner.className = 'hero-astro-inner';

  const sunBlock = document.createElement('div');
  sunBlock.className = 'hero-astro-end';
  const middle = document.createElement('div');
  fillSkyEventStrip(middle);
  const moonBlock = document.createElement('div');
  moonBlock.className = 'hero-astro-end';

  astroInner.append(sunBlock, middle, moonBlock);
  astro.append(astroInner);

  const loading = document.createElement('p');
  loading.className = 'hero-loading';
  loading.textContent = 'Loading weather…';

  cluster.append(timeCol, citiesWrap, astro, loading);
  root.appendChild(cluster);

  const tick = () => {
    const now = new Date();
    clockEl.textContent = formatTime12h(now);
    dateEl.textContent = formatDateLong(now);
  };
  tick();
  setInterval(tick, 1000);

  const oakLat = config.weatherLat;
  const oakLon = config.weatherLon;
  const sfLat = config.sfWeatherLat;
  const sfLon = config.sfWeatherLon;

  fetchAstronomyForHero(oakLat, oakLon)
    .then((a) => {
      const moonDate = a.moonrise ? new Date(a.moonrise) : new Date();
      sunBlock.replaceChildren(
        buildAstroItem(buildHeroSunsetGlyph(), 'Sunset', formatSunsetLabel(a.sunset)),
      );
      moonBlock.replaceChildren(
        buildAstroItem(buildHeroMoonGlyph(moonDate), 'Moonrise', formatMoonriseLabel(a.moonrise)),
      );
    })
    .catch(() => {
      sunBlock.replaceChildren(
        buildAstroItem(buildHeroSunsetGlyph(), 'Sunset', '—'),
      );
      moonBlock.replaceChildren(
        buildAstroItem(buildHeroMoonGlyph(new Date()), 'Moonrise', '—'),
      );
    });

  Promise.all([fetchCurrentWeather(oakLat, oakLon), fetchCurrentWeather(sfLat, sfLon)])
    .then(([wOak, wSf]) => {
      loading.remove();
      fillCityWeather(oak, wOak, 'oak');
      fillCityWeather(sf, wSf, 'sf');
    })
    .catch((e) => {
      loading.textContent = `Weather unavailable: ${e.message}`;
    });
}
