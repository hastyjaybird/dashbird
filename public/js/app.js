import { mountCalendar } from './panels/calendar.js';
import { mountBookmarkGrid } from './panels/bookmarks.js';
import { mountCalendarUpcoming } from './panels/calendar-upcoming.js';
import { mountPageTabs } from './panels/page-tabs.js';
import { mountSettingsPage } from './panels/settings-page.js';
import { mountSkySidebarToggle } from './panels/sky-sidebar-toggle.js';
import { readPanelCache, writePanelCache } from './lib/panel-cache.js';

const CONFIG_CACHE_KEY = 'config';
const CONFIG_CACHE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

async function loadConfig() {
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('config failed');
  const config = await r.json();
  writePanelCache(CONFIG_CACHE_KEY, config);
  return config;
}

/** Prefer a fresh fetch; fall back to last session so priority UI never waits on a blank config. */
async function loadConfigPreferLive() {
  try {
    return await loadConfig();
  } catch (e) {
    const cached = readPanelCache(CONFIG_CACHE_KEY, CONFIG_CACHE_MAX_MS);
    if (cached && typeof cached === 'object') return cached;
    throw e;
  }
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
let houseHunterLoaded = false;
let networkLoaded = false;

/** @param {'main' | 'network' | 'house-hunter' | 'settings'} page */
function showPage(page) {
  const main = document.getElementById('page-main');
  const settings = document.getElementById('page-settings');
  const houseHunter = document.getElementById('page-house-hunter');
  const network = document.getElementById('page-network');
  if (main) main.hidden = page !== 'main';
  if (settings) settings.hidden = page !== 'settings';
  if (houseHunter) houseHunter.hidden = page !== 'house-hunter';
  if (network) network.hidden = page !== 'network';
  if (page === 'settings' && !settingsLoaded) {
    settingsLoaded = true;
    mountSettingsPage(document.getElementById('mount-settings'));
  }
  if (page === 'house-hunter' && !houseHunterLoaded) {
    houseHunterLoaded = true;
    import('./panels/house-hunter.js')
      .then(({ mountHouseHunter }) => {
        mountHouseHunter(document.getElementById('mount-house-hunter'));
      })
      .catch((e) => console.error('House Hunter mount failed:', e));
  }
  if (page === 'network') {
    // Start contacts + companies fetch immediately (parallel with Network UI chunk).
    import('./lib/network-prefetch.js')
      .then(({ beginNetworkPrefetch }) => beginNetworkPrefetch())
      .catch(() => {});
  }
  if (page === 'network' && !networkLoaded) {
    networkLoaded = true;
    import('./panels/network.js?v=cols-persist-1')
      .then(({ mountNetwork }) => {
        mountNetwork(document.getElementById('mount-network'));
      })
      .catch((e) => console.error('Network mount failed:', e));
  }
}

function markPriorityReady() {
  document.body.classList.add('dashy--priority-ready');
}

function markDeferredReady() {
  if (document.body.classList.contains('dashy--deferred-ready')) return;
  document.body.classList.add('dashy--deferred-ready');
  for (const el of document.querySelectorAll('.boot-deferred[aria-busy]')) {
    el.removeAttribute('aria-busy');
  }
}

/**
 * Import a panel module and run its mount as soon as that chunk arrives
 * (do not wait for every deferred panel to download).
 * @param {string} label
 * @param {() => Promise<unknown>} load
 */
function mountWhenReady(label, load) {
  return load()
    .then(() => {
      markDeferredReady();
    })
    .catch((e) => {
      console.error(`${label} mount failed:`, e);
    });
}

/**
 * Weather, sidebars, tool library — each panel mounts as its chunk loads.
 * @param {object} config
 */
async function mountDeferredPanels(config) {
  const jobs = [
    mountWhenReady('hero', () =>
      Promise.all([
        import('./panels/hero.js'),
        import('./lib/device-location.js'),
      ]).then(([{ mountHero }, { startDeviceLocation, subscribeDevicePlace }]) => {
        const topbarEl = document.getElementById('mount-topbar-context');
        startDeviceLocation(config).then((place) => {
          if (place) renderTopbarContext(topbarEl, place);
        });
        subscribeDevicePlace((place) => renderTopbarContext(topbarEl, place));
        mountHero(document.getElementById('mount-hero'), config, {
          renderSkyStrip: true,
          skyStripMount: document.getElementById('mount-sky-strip'),
        });
      }),
    ),
    mountWhenReady('earth', () =>
      import('./panels/earth-events.js').then(({ mountEarthStrip }) => {
        mountEarthStrip(document.getElementById('mount-earth-strip'));
      }),
    ),
    mountWhenReady('weather-radar', () =>
      import('./panels/weather-radar.js').then(({ mountWeatherRadar }) => {
        mountWeatherRadar(
          document.getElementById('weather-radar-card'),
          document.getElementById('mount-weather-radar'),
        );
      }),
    ),
    mountWhenReady('geoelectric', () =>
      import('./panels/geoelectric-field.js').then(({ mountGeoelectricField }) => {
        mountGeoelectricField(
          document.getElementById('geoelectric-field-card'),
          document.getElementById('mount-geoelectric-field'),
        );
      }),
    ),
    mountWhenReady('magnetosphere', () =>
      import('./panels/magnetosphere.js').then(({ mountMagnetosphere }) => {
        mountMagnetosphere(
          document.getElementById('magnetosphere-card'),
          document.getElementById('mount-magnetosphere'),
        );
      }),
    ),
    mountWhenReady('market-watch', () =>
      import('./panels/market-watch.js').then(({ mountMarketWatch }) => {
        mountMarketWatch(document.getElementById('mount-market-watch'));
      }),
    ),
    mountWhenReady('today-todo', () =>
      import('./panels/today-todo.js').then(({ mountTodayTodo }) => {
        mountTodayTodo(document.getElementById('mount-today-todo'));
      }),
    ),
    mountWhenReady('tool-library', () =>
      import('./panels/tool-library.js').then(({ mountToolLibrary }) => {
        mountToolLibrary(document.getElementById('mount-tool-library'));
      }),
    ),
    mountWhenReady('events-finder', () =>
      import('./panels/events-finder.js?v=multi-dates-7').then(({ mountEventsFinder }) => {
        mountEventsFinder(document.getElementById('mount-events-finder'));
      }),
    ),
    mountWhenReady('local-news', () =>
      import('./panels/local-news.js').then(({ mountLocalNews }) => {
        mountLocalNews(document.getElementById('mount-local-news'));
      }),
    ),
  ];

  await Promise.allSettled(jobs);

  markDeferredReady();
}

async function main() {
  mountPageTabs(document.getElementById('mount-page-tabs'), { onChange: showPage });
  mountSkySidebarToggle(document.getElementById('sky-sidebar-toggle'));

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

  const cachedConfig = readPanelCache(CONFIG_CACHE_KEY, CONFIG_CACHE_MAX_MS);
  const configPromise = loadConfigPreferLive();

  /** Paint calendar ASAP from last session while config refreshes. */
  let config =
    cachedConfig && typeof cachedConfig === 'object' ? cachedConfig : await configPromise;

  const calUpcomingMount = document.getElementById('mount-cal-upcoming');
  if (calUpcomingMount) {
    mountCalendarUpcoming(calUpcomingMount, config, {});
  }

  mountCalendar(document.getElementById('mount-calendar'), config);

  void import('./panels/notes.js')
    .then(({ mountNotes }) => {
      mountNotes(document.getElementById('mount-notes'), config);
    })
    .catch((e) => console.error('Notes mount failed:', e));

  void import('./panels/dev-sticky-note.js')
    .then(({ mountDevStickyNote }) => {
      mountDevStickyNote();
    })
    .catch((e) => console.error('Dev sticky mount failed:', e));

  /* Refresh notes link if config was painted from cache and live fetch differs. */
  void configPromise.then((fresh) => {
    if (!fresh || typeof fresh !== 'object') return;
    if (fresh.vikunjaPublicUrl === config.vikunjaPublicUrl) return;
    import('./panels/notes.js')
      .then(({ mountNotes }) => {
        mountNotes(document.getElementById('mount-notes'), fresh);
      })
      .catch(() => {});
  });

  markPriorityReady();

  void Promise.allSettled([bookmarksPersonalPromise, bookmarksWorkPromise]);

  /* Start deferred panels right after priority paint — do not wait for idle. */
  const scheduleDeferred =
    typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(() => fn(), { timeout: 200 })
      : (fn) => setTimeout(fn, 0);

  scheduleDeferred(() => {
    mountDeferredPanels(config).catch((e) => {
      console.error('Deferred panels failed:', e);
    });
  });

  /* Keep config cache warm even when we painted from last session. */
  void configPromise.then((fresh) => {
    if (fresh && typeof fresh === 'object') config = fresh;
  });
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<p class="err err--banner">Failed to start dashboard: ${String(e.message)}</p>`,
  );
});
