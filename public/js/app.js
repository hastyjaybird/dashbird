import { mountPageTabs } from './panels/page-tabs.js';

const CONFIG_CACHE_KEY = 'dashbird-config-v2';
const CONFIG_CACHE_MAX_MS = 6 * 60 * 60 * 1000;
const CALENDAR_CACHE_KEY = 'dashbird-cal-upcoming-v1';

function readTimedCache(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached?.at || !cached.payload) return null;
    if (Date.now() - cached.at > maxAgeMs) return null;
    return cached.payload;
  } catch {
    return null;
  }
}

function writeTimedCache(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), payload }));
  } catch {
    try {
      sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), payload }));
    } catch {
      /* ignore */
    }
  }
}

function loadCachedConfig() {
  return readTimedCache(CONFIG_CACHE_KEY, CONFIG_CACHE_MAX_MS);
}

async function loadConfig() {
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('config failed');
  const config = await r.json();
  writeTimedCache(CONFIG_CACHE_KEY, config);
  return config;
}

function preloadCalendarUpcoming() {
  return fetch('/api/calendar/upcoming', { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => null);
}

function readCalendarUpcomingCache() {
  try {
    const raw = sessionStorage.getItem(CALENDAR_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached?.at || !Array.isArray(cached.events)) return null;
    return {
      ok: true,
      events: cached.events,
      timeZone: cached.timeZone,
    };
  } catch {
    return null;
  }
}

function onIdle(fn, timeout = 1200) {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(fn, { timeout });
    return;
  }
  window.setTimeout(fn, 0);
}

function runSoon(fn) {
  window.setTimeout(fn, 0);
}

function reportPanelError(name, error) {
  console.warn(`dashbird: failed to mount ${name}`, error);
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
let settingsLoading = false;

function showPage(page) {
  const main = document.getElementById('page-main');
  const settings = document.getElementById('page-settings');
  const isSettings = page === 'settings';
  if (main) main.hidden = isSettings;
  if (settings) settings.hidden = !isSettings;
  if (isSettings && !settingsLoaded && !settingsLoading) {
    settingsLoading = true;
    import('./panels/settings-page.js')
      .then(({ mountSettingsPage }) => {
        settingsLoaded = true;
        mountSettingsPage(document.getElementById('mount-settings'));
      })
      .catch((error) => {
        reportPanelError('settings', error);
        const root = document.getElementById('mount-settings');
        if (root) root.innerHTML = '<p class="err">Failed to load settings.</p>';
      })
      .finally(() => {
        settingsLoading = false;
      });
  }
}

async function main() {
  mountPageTabs(document.getElementById('mount-page-tabs'), { onChange: showPage });

  const cachedConfig = loadCachedConfig();
  if (cachedConfig) mountTopbarContext(document.getElementById('mount-topbar-context'), cachedConfig);

  const configPromise = loadConfig();
  configPromise
    .then((freshConfig) => mountTopbarContext(document.getElementById('mount-topbar-context'), freshConfig))
    .catch((error) => {
      if (cachedConfig) reportPanelError('fresh config', error);
    });

  const calendarUpcomingPromise = preloadCalendarUpcoming();
  const config = cachedConfig || (await configPromise);

  const heroPromise = import('./panels/hero.js')
    .then(({ mountHero }) => {
      mountHero(document.getElementById('mount-hero'), config, {
        renderSkyStrip: true,
        skyStripMount: document.getElementById('mount-sky-strip'),
      });
    })
    .catch((error) => reportPanelError('hero', error));

  const calendarUpcomingMount = document.getElementById('mount-cal-upcoming');
  const cachedCalendar = readCalendarUpcomingCache();
  import('./panels/calendar-upcoming.js')
    .then(async ({ mountCalendarUpcoming }) => {
      if (!calendarUpcomingMount) return;
      mountCalendarUpcoming(calendarUpcomingMount, config, {
        prefetched: cachedCalendar || (await calendarUpcomingPromise),
      });
    })
    .catch((error) => reportPanelError('calendar upcoming', error));

  await heroPromise;

  runSoon(() => {
    import('./panels/bookmarks.js')
      .then(({ mountBookmarkGrid }) =>
        Promise.all([
          mountBookmarkGrid(
            document.getElementById('mount-bookmarks-personal'),
            '/data/bookmarks-personal.json',
            'Add tiles in public/data/bookmarks-personal.json (up to 9).',
          ),
          mountBookmarkGrid(
            document.getElementById('mount-bookmarks-work'),
            '/data/bookmarks-work.json',
            'Add tiles in public/data/bookmarks-work.json.',
          ),
        ]),
      )
      .catch((error) => reportPanelError('bookmarks', error));
  });

  runSoon(() => {
    import('./panels/today-todo.js')
      .then(({ mountTodayTodo }) => mountTodayTodo(document.getElementById('mount-today-todo')))
      .catch((error) => reportPanelError('today todo', error));
  });

  runSoon(() => {
    import('./panels/earth-events.js')
      .then(({ mountEarthStrip }) => mountEarthStrip(document.getElementById('mount-earth-strip')))
      .catch((error) => reportPanelError('earth strip', error));
  });

  runSoon(() => {
    import('./panels/market-watch.js')
      .then(({ mountMarketWatch }) => mountMarketWatch(document.getElementById('mount-market-watch')))
      .catch((error) => reportPanelError('market watch', error));
  });

  onIdle(() => {
    import('./panels/chat.js')
      .then(({ mountChat }) => mountChat(document.getElementById('mount-chat'), config))
      .catch((error) => reportPanelError('chat', error));
  }, 900);

  onIdle(() => {
    import('./panels/weather-radar.js')
      .then(({ mountWeatherRadar }) =>
        mountWeatherRadar(
          document.getElementById('weather-radar-card'),
          document.getElementById('mount-weather-radar'),
        ),
      )
      .catch((error) => reportPanelError('weather radar', error));
  }, 1200);

  onIdle(() => {
    import('./panels/geoelectric-field.js')
      .then(({ mountGeoelectricField }) =>
        mountGeoelectricField(
          document.getElementById('geoelectric-field-card'),
          document.getElementById('mount-geoelectric-field'),
        ),
      )
      .catch((error) => reportPanelError('geoelectric field', error));
  }, 1400);

  onIdle(() => {
    import('./panels/magnetosphere.js')
      .then(({ mountMagnetosphere }) =>
        mountMagnetosphere(
          document.getElementById('magnetosphere-card'),
          document.getElementById('mount-magnetosphere'),
        ),
      )
      .catch((error) => reportPanelError('magnetosphere', error));
  }, 1600);

  onIdle(() => {
    import('./panels/calendar.js')
      .then(({ mountCalendar }) => mountCalendar(document.getElementById('mount-calendar'), config))
      .catch((error) => reportPanelError('calendar', error));
  }, 1800);

  onIdle(() => {
    import('./panels/tool-library.js')
      .then(({ mountToolLibrary }) => mountToolLibrary(document.getElementById('mount-tool-library')))
      .catch((error) => reportPanelError('tool library', error));
  }, 2200);

  onIdle(() => {
    const healthAside = document.getElementById('mount-health-sidebar');
    if (!healthAside) return;
    import('./panels/health-sidebar.js')
      .then(({ mountHealthSidebar }) => mountHealthSidebar(healthAside))
      .catch((error) => reportPanelError('health sidebar', error));
  }, 2500);
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<p class="err err--banner">Failed to start dashboard: ${String(e.message)}</p>`,
  );
});
