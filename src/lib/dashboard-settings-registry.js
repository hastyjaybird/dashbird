/**
 * Dashboard configuration variables for the Settings page.
 * `source` describes where the value comes from; `value` is filled at request time.
 *
 * @typedef {{
 *   key: string,
 *   group: string,
 *   label: string,
 *   source: string,
 *   secret?: boolean,
 * }} SettingVariableDef
 */

/** @type {SettingVariableDef[]} */
export const DASHBOARD_SETTING_VARIABLES = [
  { key: 'PORT', group: 'Runtime', label: 'Server listen port (container)', source: '.env → process.env.PORT' },
  { key: 'HOST_PORT', group: 'Runtime', label: 'Published port (docker compose)', source: 'docker-compose.yml host mapping' },
  { key: 'LAST_BACKUP_AT', group: 'Health sidebar', label: 'Last backup timestamp', source: '.env or public/data/last-backup.txt' },
  { key: 'GOOGLE_CALENDAR_ICAL_URL', group: 'Calendar', label: 'Google Calendar iCal feed', source: '.env → /api/calendar/upcoming' },
  { key: 'CALENDAR_EMBED_URL', group: 'Calendar', label: 'Calendar iframe embed URL', source: '.env (optional override)' },
  {
    key: 'EVENTS_FINDER_GOOGLE_CALENDAR_NAME',
    group: 'Calendar',
    label: 'Events finder add-to-calendar label',
    source: '.env (default Random Events)',
  },
  {
    key: 'EVENTS_FINDER_GOOGLE_CALENDAR_AUTHUSER',
    group: 'Calendar',
    label: 'Events finder Google account (authuser)',
    source: '.env (default julia.hasty@gmail.com)',
  },
  {
    key: 'EVENTS_FINDER_GOOGLE_CALENDAR_SRC',
    group: 'Calendar',
    label: 'Events finder Google Calendar ID (src)',
    source: '.env → Calendar Settings → Integrate calendar → Calendar ID',
  },
  { key: 'GOOGLE_OAUTH_CLIENT_ID', group: 'Events (Gmail intake)', label: 'Google OAuth client ID', source: '.env → Gmail Events OAuth' },
  { key: 'GOOGLE_OAUTH_CLIENT_SECRET', group: 'Events (Gmail intake)', label: 'Google OAuth client secret', source: '.env → Gmail Events OAuth', secret: true },
  { key: 'GMAIL_INTAKE_ADDRESSES', group: 'Events (Gmail intake)', label: 'Intake Gmail addresses (comma-separated)', source: '.env (default jay.intake.box@gmail.com,julia.hasty@gmail.com)' },
  { key: 'GMAIL_INTAKE_ADDRESS', group: 'Events (Gmail intake)', label: 'Intake Gmail address (legacy single / alias)', source: '.env → prefer GMAIL_INTAKE_ADDRESSES' },
  { key: 'APIFY_TOKEN', group: 'Events (Facebook / Apify)', label: 'Apify API token', source: '.env → facebook-events-scraper', secret: true },
  { key: 'APIFY_FACEBOOK_ACTOR_ID', group: 'Events (Facebook / Apify)', label: 'Facebook Events Actor ID', source: '.env (default apify/facebook-events-scraper)' },
  { key: 'FACEBOOK_EVENTS_LOCATION', group: 'Events (Facebook / Apify)', label: 'Default city for search queries', source: '.env (default San Francisco / dashboard city)' },
  { key: 'FACEBOOK_EVENTS_MAX_EVENTS', group: 'Events (Facebook / Apify)', label: 'Max events per search query', source: '.env (default 30)' },
  { key: 'FACEBOOK_EVENTS_CACHE_MS', group: 'Events (Facebook / Apify)', label: 'Facebook cache TTL (ms)', source: '.env (default 3600000)' },
  { key: 'FACEBOOK_EVENTS_WEEKLY', group: 'Events (Facebook / Apify)', label: 'Weekly Tuesday-night scrape', source: '.env (1=on, 0=off; default on)' },
  { key: 'FACEBOOK_EVENTS_WEEKLY_HOUR', group: 'Events (Facebook / Apify)', label: 'Weekly scrape local hour', source: '.env (default 21)' },
  { key: 'FACEBOOK_EVENTS_WEEKLY_TZ', group: 'Events (Facebook / Apify)', label: 'Weekly scrape timezone', source: '.env (default America/Los_Angeles)' },
  { key: 'TELEGRAM_BOT_TOKEN', group: 'Events (Telegram intake)', label: 'Telegram bot token (BotFather)', source: '.env → events-finder-telegram', secret: true },
  { key: 'TELEGRAM_EVENTS_ENABLED', group: 'Events (Telegram intake)', label: 'Enable Telegram Events poller', source: '.env (1=on; auto-on when token set)' },
  { key: 'TELEGRAM_ALLOWED_CHAT_IDS', group: 'Events (Telegram intake)', label: 'Allowed Telegram chat ids', source: '.env (comma-separated; /start prints yours)' },
  { key: 'WEATHER_ZIP', group: 'Location & weather', label: 'Primary ZIP (overrides lat/lon)', source: '.env → Zippopotam geocode' },
  { key: 'WEATHER_LAT', group: 'Location & weather', label: 'Primary latitude', source: '.env (default Oakland 94608)' },
  { key: 'WEATHER_LON', group: 'Location & weather', label: 'Primary longitude', source: '.env' },
  { key: 'WEATHER_TIME_ZONE', group: 'Location & weather', label: 'Hero / sky IANA timezone', source: '.env or NWS api.weather.gov points timeZone' },
  { key: 'DASHBOARD_LOCATION_LABEL', group: 'Location & weather', label: 'Human location label', source: '.env → top bar & Earth rows' },
  { key: 'SF_WEATHER_LAT', group: 'Location & weather', label: 'San Francisco tile latitude', source: '.env → hero weather (Open-Meteo)' },
  { key: 'SF_WEATHER_LON', group: 'Location & weather', label: 'San Francisco tile longitude', source: '.env' },
  { key: 'NWS_USER_AGENT', group: 'Location & weather', label: 'NWS API User-Agent', source: '.env (required by api.weather.gov)' },
  { key: 'SKY_ANNULAR_ECLIPSE_NASA', group: 'Sky & space', label: 'Live NASA annular eclipse row', source: '.env (0 disables)' },
  { key: 'SKY_DEBUG_GEOMAGNETIC_ACTIVE', group: 'Sky & space', label: 'Force geomagnetic UI (G2 preview)', source: '.env debug only' },
  { key: 'GEOELECTRIC_FIELD', group: 'Sky & space', label: 'Geoelectric field panel', source: '.env (0 disables; shown above G1 only)' },
  { key: 'MAGNETOSPHERE', group: 'Sky & space', label: 'Magnetosphere animation panel', source: '.env (0 disables; shown above G1 only)' },
  { key: 'EARTH_DEBUG_SHOW_INACTIVE', group: 'Earth', label: 'Show inactive Earth debug rows', source: '.env debug only' },
  { key: 'EARTH_USGS_QUAKE_WEEK', group: 'Earth', label: 'USGS earthquake week row', source: '.env (0 disables)' },
  { key: 'EARTH_GOES_GLM_LIGHTNING', group: 'Earth', label: 'GOES GLM lightning row', source: '.env (0 disables)' },
  { key: 'EARTH_GOES_GLM_BUCKET', group: 'Earth', label: 'GOES S3 bucket override', source: '.env (default noaa-goes18/16)' },
  { key: 'EARTH_USA_NPN_SPRING', group: 'Earth', label: 'USA-NPN spring index row', source: '.env (0 disables)' },
  { key: 'USANPN_GEOSERVER_BASE', group: 'Earth', label: 'USA-NPN GeoServer base URL', source: '.env' },
  { key: 'EARTH_YOSEMITE_MOONBOW', group: 'Earth', label: 'Yosemite moonbow sky row', source: '.env + public/data/yosemite-moonbow-windows.json' },
  { key: 'EARTH_DIABLO_TARANTULA', group: 'Earth', label: 'Diablo tarantula row', source: '.env + public/data/diablo-tarantula-season.json' },
  { key: 'TARANTULA_DIABLO_RADIUS_MI', group: 'Earth', label: 'Tarantula radius (miles)', source: '.env' },
  { key: 'EARTH_OAKLAND_SALAMANDERS', group: 'Earth', label: 'Oakland salamander row', source: '.env + Open-Meteo' },
  { key: 'EARTH_NASTURTIUM_BLOOM', group: 'Earth', label: 'Nasturtium bloom row', source: '.env (0=off) · /api/nasturtium-bloom' },
  { key: 'SALMON_RUN_RADIUS_MI', group: 'Earth', label: 'Salmon runs search radius', source: '.env → /api/salmon-runs' },
  { key: 'EDIBLE_NATIVE_PLANT_RADIUS_MI', group: 'Earth', label: 'Wild native plants radius', source: '.env → /api/wild-foraging' },
  { key: 'FALLING_FRUIT_API_KEY', group: 'Earth', label: 'Falling Fruit API key', source: '.env (optional)', secret: true },
  { key: 'FALLING_FRUIT_MAX_DISTANCE_M', group: 'Earth', label: 'Falling Fruit max distance (m)', source: '.env' },
  { key: 'FALLING_FRUIT_LOCATION_LIMIT', group: 'Earth', label: 'Falling Fruit result limit', source: '.env' },
  { key: 'KDENLIVE_APPIMAGE', group: 'Local apps', label: 'Kdenlive AppImage path', source: '.env or ~/Applications/*.AppImage' },
  { key: 'NET_HEALTH_PING_HOST', group: 'Health sidebar', label: 'Network probe ping host', source: '.env → /api/network-health' },
  { key: 'NET_HEALTH_TCP_HOST', group: 'Health sidebar', label: 'Network probe TCP host', source: '.env' },
  { key: 'NET_HEALTH_TCP_PORT', group: 'Health sidebar', label: 'Network probe TCP port', source: '.env' },
  { key: 'SUPERBLOOM_REFRESH_MS', group: 'Background agents', label: 'Superbloom refresh interval', source: '.env → /api/superbloom-status' },
  { key: 'VIKUNJA_BASE_URL', group: 'Todos (Vikunja)', label: 'Vikunja base URL', source: '.env → /api/vikunja' },
  { key: 'VIKUNJA_TOKEN', group: 'Todos (Vikunja)', label: 'Vikunja API token', source: '.env → /api/vikunja', secret: true },
  { key: 'VIKUNJA_PROJECT_ID', group: 'Todos (Vikunja)', label: 'Vikunja project ID', source: '.env → /api/vikunja/todos' },
  {
    key: 'VIKUNJA_ARCHIVE_PROJECT_ID',
    group: 'Todos (Vikunja)',
    label: 'Vikunja archive project ID',
    source: '.env → completed todos move here',
  },
  { key: 'HASS_BASE_URL', group: 'v2 (unused)', label: 'Home Assistant URL', source: '.env (v2 stub)' },
];

const SECRET_KEY_RE = /(API_KEY|TOKEN|SECRET|PASSWORD)/i;

/**
 * @param {string} key
 * @param {Record<string, string>} resolved
 */
function formatValue(key, resolved) {
  const def = DASHBOARD_SETTING_VARIABLES.find((d) => d.key === key);
  const secret = def?.secret || SECRET_KEY_RE.test(key);
  const raw = resolved[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return '(not set)';
  if (secret) return '(set — hidden)';
  if (String(raw).length > 120) return `${String(raw).slice(0, 117)}…`;
  return String(raw);
}

/**
 * @param {Record<string, string>} resolved
 */
export function buildVariablesPayload(resolved) {
  const groups = [];
  const variables = DASHBOARD_SETTING_VARIABLES.map((def) => {
    if (!groups.includes(def.group)) groups.push(def.group);
    const value = formatValue(def.key, resolved);
    const configured =
      resolved[def.key] !== undefined &&
      resolved[def.key] !== null &&
      String(resolved[def.key]).trim() !== '';
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      source: def.source,
      value,
      configured,
      secret: Boolean(def.secret || SECRET_KEY_RE.test(def.key)),
    };
  });
  return { groups, variables };
}
