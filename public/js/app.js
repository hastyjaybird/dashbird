import { mountCalendar } from './panels/calendar.js';
import { mountBookmarkGrid } from './panels/bookmarks.js';
import { mountCalendarUpcoming } from './panels/calendar-upcoming.js';
import { mountPageTabs } from './panels/page-tabs.js';
import { mountSettingsPage } from './panels/settings-page.js';
import { debugLog } from './lib/debugLog.js';

async function loadConfig() {
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('config failed');
  return r.json();
}

/**
 * Header top-right: live device place when GPS is allowed, else server WEATHER_ZIP/lat/lon.
 * @param {HTMLElement | null} el
 * @param {{ shortLabel?: string, timeZone?: string, source?: string, label?: string }} place
 */
function renderTopbarContext(el, place) {
  if (!el || !place) return;

  const tz = (place.timeZone || '').trim() || '—';
  const loc = (place.shortLabel || '').trim() || '—';
  const live = place.source === 'device';

  el.replaceChildren();
  const lineTz = document.createElement('span');
  lineTz.className = 'topbar__context-line topbar__context-tz';
  lineTz.textContent = tz;

  const lineLoc = document.createElement('span');
  lineLoc.className = 'topbar__context-line topbar__context-loc';
  lineLoc.textContent = live ? `${loc} · live` : loc;

  el.append(lineTz, lineLoc);
  el.title = live
    ? `Your current location (${place.label || loc}). Rain alert uses this point.`
    : 'Server default location (WEATHER_ZIP). Allow location in the browser for live updates.';
}

let settingsLoaded = false;

function showPage(page) {
  const main = document.getElementById('page-main');
  const settings = document.getElementById('page-settings');
  const isSettings = page === 'settings';
  if (main) main.hidden = isSettings;
  if (settings) settings.hidden = !isSettings;
  if (isSettings && !settingsLoaded) {
    settingsLoaded = true;
    mountSettingsPage(document.getElementById('mount-settings'));
  }
}

function markPriorityReady() {
  document.body.classList.add('dashy--priority-ready');
}

/**
 * Weather, sidebars, tool library — parsed and mounted after search/bookmarks/calendar.
 * @param {object} config
 */
async function mountDeferredPanels(config) {
  const [
    { mountHero },
    { mountEarthStrip },
    { mountWeatherRadar },
    { mountGeoelectricField },
    { mountMagnetosphere },
    { mountMarketWatch },
    { mountTodayTodo },
    { mountToolLibrary },
    { startDeviceLocation, subscribeDevicePlace },
  ] = await Promise.all([
    import('./panels/hero.js'),
    import('./panels/earth-events.js'),
    import('./panels/weather-radar.js'),
    import('./panels/geoelectric-field.js'),
    import('./panels/magnetosphere.js'),
    import('./panels/market-watch.js'),
    import('./panels/today-todo.js'),
    import('./panels/tool-library.js'),
    import('./lib/device-location.js'),
  ]);

  const topbarEl = document.getElementById('mount-topbar-context');
  startDeviceLocation(config).then((place) => {
    if (place) renderTopbarContext(topbarEl, place);
  });
  subscribeDevicePlace((place) => renderTopbarContext(topbarEl, place));

  const skyStripMount = document.getElementById('mount-sky-strip');
  mountHero(document.getElementById('mount-hero'), config, {
    renderSkyStrip: true,
    skyStripMount,
  });
  mountEarthStrip(document.getElementById('mount-earth-strip'));

  mountWeatherRadar(
    document.getElementById('weather-radar-card'),
    document.getElementById('mount-weather-radar'),
  );
  mountGeoelectricField(
    document.getElementById('geoelectric-field-card'),
    document.getElementById('mount-geoelectric-field'),
  );
  mountMagnetosphere(
    document.getElementById('magnetosphere-card'),
    document.getElementById('mount-magnetosphere'),
  );
  mountMarketWatch(document.getElementById('mount-market-watch'));
  mountTodayTodo(document.getElementById('mount-today-todo'));
  mountToolLibrary(document.getElementById('mount-tool-library'));

  document.body.classList.add('dashy--deferred-ready');
  for (const el of document.querySelectorAll('.boot-deferred[aria-busy]')) {
    el.removeAttribute('aria-busy');
  }

  debugLog({
    location: 'app.js:mountDeferredPanels',
    message: 'dashbird deferred panels mounted',
    hypothesisId: 'H2',
    data: { panels: 'deferred-complete' },
  });
}

async function main() {
  mountPageTabs(document.getElementById('mount-page-tabs'), { onChange: showPage });

  const bookmarksPersonalPromise = mountBookmarkGrid(
    document.getElementById('mount-bookmarks-personal'),
    '/data/bookmarks-personal.json',
    'Add tiles in public/data/bookmarks-personal.json (up to 9).',
  );
  const bookmarksWorkPromise = mountBookmarkGrid(
    document.getElementById('mount-bookmarks-work'),
    '/data/bookmarks-work.json',
    'Add tiles in public/data/bookmarks-work.json.',
  );

  const config = await loadConfig();

  const calUpcomingMount = document.getElementById('mount-cal-upcoming');
  if (calUpcomingMount) {
    mountCalendarUpcoming(calUpcomingMount, config, {});
  }

  mountCalendar(document.getElementById('mount-calendar'), config);

  markPriorityReady();

  void Promise.allSettled([bookmarksPersonalPromise, bookmarksWorkPromise]);

  const scheduleDeferred =
    typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(() => fn(), { timeout: 1200 })
      : (fn) => setTimeout(fn, 0);

  scheduleDeferred(() => {
    mountDeferredPanels(config).catch((e) => {
      console.error('Deferred panels failed:', e);
    });
  });
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<p class="err err--banner">Failed to start dashboard: ${String(e.message)}</p>`,
  );
});
