import { mountCalendar } from './panels/calendar.js';
import { mountBookmarkGrid } from './panels/bookmarks.js';
import { mountHero } from './panels/hero.js';
import { debugLog } from './lib/debugLog.js';
import { mountHealthSidebar } from './panels/health-sidebar.js';
import { mountCalendarUpcoming } from './panels/calendar-upcoming.js';
import { mountMarketWatch } from './panels/market-watch.js';
import { mountWeatherRadar } from './panels/weather-radar.js';
import { mountGeoelectricField } from './panels/geoelectric-field.js';
import { mountMagnetosphere } from './panels/magnetosphere.js';
import { mountPageTabs } from './panels/page-tabs.js';
import { mountSettingsPage } from './panels/settings-page.js';
import { mountToolLibrary } from './panels/tool-library.js';
import { mountEarthStrip } from './panels/earth-events.js';
import { mountTodayTodo } from './panels/today-todo.js';

async function loadConfig() {
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('config failed');
  return r.json();
}

/**
 * Primary dashboard point: ZIP (if set) else lat/lon; IANA zone for hero clock / sky strip / NWS sunset.
 */
function mountTopbarContext(el, config) {
  if (!el || !config) return;
  const zipRaw = config.weatherZip != null ? String(config.weatherZip).trim() : '';
  const lat = Number(config.weatherLat);
  const lon = Number(config.weatherLon);
  const tz = (config.weatherTimeZone || '').trim() || '—';

  const locationLine =
    zipRaw.length > 0
      ? zipRaw
      : `Lat/Lon ${Number.isFinite(lat) ? lat.toFixed(3) : '—'}, ${Number.isFinite(lon) ? lon.toFixed(3) : '—'}`;

  el.replaceChildren();
  const lineTz = document.createElement('span');
  lineTz.className = 'topbar__context-line topbar__context-tz';
  lineTz.textContent = tz;

  const lineLoc = document.createElement('span');
  lineLoc.className = 'topbar__context-line topbar__context-loc';
  lineLoc.textContent = locationLine;

  el.append(lineTz, lineLoc);
  el.title =
    'Primary coordinates and timezone from server config (WEATHER_ZIP or WEATHER_LAT/LON; WEATHER_TIME_ZONE or NWS). Oakland weather tile and SF tile use their own points.';
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

async function main() {
  mountPageTabs(document.getElementById('mount-page-tabs'), { onChange: showPage });

  const calendarUpcomingPromise = fetch('/api/calendar/upcoming', { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => null);

  const config = await loadConfig();

  mountTopbarContext(document.getElementById('mount-topbar-context'), config);

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

  const calUpcomingMount = document.getElementById('mount-cal-upcoming');
  if (calUpcomingMount) {
    calendarUpcomingPromise
      .then((prefetchedCalendar) => {
        mountCalendarUpcoming(calUpcomingMount, config, { prefetched: prefetchedCalendar });
      })
      .catch(() => {
        mountCalendarUpcoming(calUpcomingMount, config, { prefetched: null });
      });
  }

  await Promise.allSettled([bookmarksPersonalPromise, bookmarksWorkPromise]);

  mountCalendar(document.getElementById('mount-calendar'), config);
  mountToolLibrary(document.getElementById('mount-tool-library'));

  const healthAside = document.getElementById('mount-health-sidebar');
  if (healthAside) mountHealthSidebar(healthAside);

  // #region agent log
  debugLog({
    location: 'app.js:main',
    message: 'dashbird boot complete (chat sidebar removed)',
    hypothesisId: 'H2',
    data: { panels: 'no-chat' },
  });
  // #endregion
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<p class="err err--banner">Failed to start dashboard: ${String(e.message)}</p>`,
  );
});
