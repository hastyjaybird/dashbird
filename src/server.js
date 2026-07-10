import 'dotenv/config';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printLanUrl } from './lib/lan-url.js';

import configRouter from './routes/config.js';
import vikunjaRouter from './routes/vikunja.js';
import homeAssistantRouter from './routes/homeassistant.js';
import skyEventsRouter from './routes/sky-events.js';
import hostHealthRouter from './routes/host-health.js';
import dashboardCheckRouter from './routes/dashboard-check.js';
import monitoringSourcesRouter from './routes/monitoring-sources.js';
import dashboardSettingsRouter from './routes/dashboard-settings.js';
import eventTypesStatusRouter from './routes/event-types-status.js';
import eventsFinderStatusRouter from './routes/events-finder-status.js';
import eventsFinderCriteriaRouter from './routes/events-finder-criteria.js';
import eventsFinderGmailRouter from './routes/events-finder-gmail.js';
import eventsFinderEventsRouter from './routes/events-finder-events.js';
import openDesktopRouter from './routes/open-desktop.js';
import networkHealthRouter from './routes/network-health.js';
import heroAstronomyRouter from './routes/hero-astronomy.js';
import heroWeatherRouter from './routes/hero-weather.js';
import calendarUpcomingRouter from './routes/calendar-upcoming.js';
import earthEventsRouter from './routes/earth-events.js';
import superbloomStatusRouter from './routes/superbloom-status.js';
import salmonRunsRouter from './routes/salmon-runs.js';
import wildForagingRouter from './routes/wild-foraging.js';
import usaNpnSpringRouter from './routes/usa-npn-spring.js';
import yosemiteMoonbowRouter from './routes/yosemite-moonbow.js';
import diabloTarantulaRouter from './routes/diablo-tarantula.js';
import oaklandSalamandersRouter from './routes/oakland-salamanders.js';
import nasturtiumBloomRouter from './routes/nasturtium-bloom.js';
import dashboardEarthquakeWeekRouter from './routes/dashboard-earthquake-week.js';
import dashboardLightningGlmRouter from './routes/dashboard-lightning-glm.js';
import marketWatchRouter from './routes/market-watch.js';
import rainAlertRouter from './routes/rain-alert.js';
import geolocationRouter from './routes/geolocation.js';
import airQualityRouter from './routes/air-quality.js';
import weatherRadarRouter from './routes/weather-radar.js';
import openrouterRouter from './routes/openrouter.js';
import weatherAuthorityMemosRouter from './routes/weather-authority-memos.js';
import atlanticStormWatchRouter from './routes/atlantic-storm-watch.js';
import geoelectricFieldRouter from './routes/geoelectric-field.js';
import magnetosphereRouter from './routes/magnetosphere.js';
import { startGeospaceMagnetosphereMonitor } from './lib/geospace-magnetosphere.js';
import secondaryWatchRouter from './routes/secondary-watch.js';
import aircraftNearbyRouter from './routes/aircraft-nearby.js';
import { startSuperbloomAgent } from './lib/superbloom-agent.js';
import { warmGoogleCalendarCache } from './lib/google-calendar-ical.js';
import { resolveDashboardWeatherLatLon } from './lib/hero-weather-location.js';
import toolLibraryRouter from './routes/tool-library.js';
import webCatalogRouter from './routes/web-catalog.js';
import { startWebCatalogWatchPoller } from './lib/web-catalog-watch.js';
import { startWebCatalogDiscoveryWorker } from './lib/web-catalog-discovery.js';
import { startFacebookEventsWeeklyScheduler } from './lib/events-finder-facebook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const docsDir = path.join(root, 'docs');
const leafletDir = path.join(root, 'node_modules', 'leaflet', 'dist');

const app = express();
const port = Number(process.env.PORT) || 3000;
const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';

app.use(
  express.static(publicDir, {
    extensions: ['html'],
    /**
     * Local/dev: always revalidate so edits show up immediately.
     * Production: short-lived cache for static assets to reduce repeat RTT on remote hosts.
     */
    setHeaders(res, filePath) {
      const p = String(filePath || '').toLowerCase();
      if (!isProd) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        return;
      }
      const isHtml = p.endsWith('.html');
      if (isHtml) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    },
  }),
);
app.use('/docs', express.static(docsDir));
app.use('/vendor/leaflet', express.static(leafletDir));

app.use('/api/config', configRouter);
app.use('/api/vikunja', vikunjaRouter);
app.use('/api/home-assistant', homeAssistantRouter);
app.use('/api/sky-events', skyEventsRouter);
app.use('/api/host-health', hostHealthRouter);
app.use('/api/network-health', networkHealthRouter);
app.use('/api/hero-astronomy', heroAstronomyRouter);
app.use('/api/hero-weather', heroWeatherRouter);
app.use('/api/calendar', calendarUpcomingRouter);
app.use('/api/earth-events', earthEventsRouter);
app.use('/api/superbloom-status', superbloomStatusRouter);
app.use('/api/salmon-runs', salmonRunsRouter);
app.use('/api/wild-foraging', wildForagingRouter);
app.use('/api/usa-npn-spring', usaNpnSpringRouter);
app.use('/api/yosemite-moonbow', yosemiteMoonbowRouter);
app.use('/api/diablo-tarantula', diabloTarantulaRouter);
app.use('/api/oakland-salamanders', oaklandSalamandersRouter);
app.use('/api/nasturtium-bloom', nasturtiumBloomRouter);
app.use('/api/dashboard-earthquake-week', dashboardEarthquakeWeekRouter);
app.use('/api/dashboard-lightning-glm', dashboardLightningGlmRouter);
app.use('/api/market-watch', marketWatchRouter);
app.use('/api/rain-alert', rainAlertRouter);
app.use('/api/geolocation', geolocationRouter);
app.use('/api/air-quality', airQualityRouter);
app.use('/api/weather-radar', weatherRadarRouter);
app.use('/api/openrouter', openrouterRouter);
app.use('/api/weather-authority-memos', weatherAuthorityMemosRouter);
app.use('/api/atlantic-storm-watch', atlanticStormWatchRouter);
app.use('/api/geoelectric-field', geoelectricFieldRouter);
app.use('/api/magnetosphere', magnetosphereRouter);
app.use('/api/secondary-watch', secondaryWatchRouter);
app.use('/api/aircraft-nearby', aircraftNearbyRouter);
app.use('/api/dashboard-check', dashboardCheckRouter);
app.use('/api/monitoring-sources', monitoringSourcesRouter);
app.use('/api/dashboard-settings', dashboardSettingsRouter);
app.use('/api/event-types-status', eventTypesStatusRouter);
app.use('/api/events-finder-status', eventsFinderStatusRouter);
app.use('/api/events-finder-criteria', eventsFinderCriteriaRouter);
app.use('/api/events-finder-gmail', eventsFinderGmailRouter);
app.use('/api/events-finder/events', eventsFinderEventsRouter);
app.use('/api/open-desktop', openDesktopRouter);
app.use('/api/tool-library', toolLibraryRouter);
app.use('/api/web-catalog', webCatalogRouter);

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal_error' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`dashbird listening on http://0.0.0.0:${port}`);
  if (!existsSync('/.dockerenv')) {
    printLanUrl();
  }
  startSuperbloomAgent();
  startGeospaceMagnetosphereMonitor();
  startWebCatalogWatchPoller();
  startWebCatalogDiscoveryWorker();
  startFacebookEventsWeeklyScheduler();
  warmGoogleCalendarCache();
  // Prime ZIP → lat/lon so the first page-load fan-out does not wait on Zippopotam.
  void resolveDashboardWeatherLatLon().catch(() => {});
});
