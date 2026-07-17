/**
 * Random task picker: context resolution + filter + pick.
 */
import { haversineMiles } from './dashboard-geo.js';
import { geocodeAddress } from './geocode-address.js';
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';
import { loadRainAlertAddress } from './rain-alert-address-store.js';
import {
  DURATION_TIER,
  DIFFICULTY_LABELS,
  DURATION_LABELS,
  LOCATION_LABELS,
  TIME_LABELS,
  normalizeDifficulty,
  normalizeDuration,
  PRIORITY_WEIGHT,
} from './task-random-enums.js';

const HOME_RADIUS_MI = 100 / 1760;
const MAKERFARM_RADIUS_MI = 150 / 1609.344;

/** @type {{ lat: number, lon: number } | null} */
let cachedMakerfarm = null;

async function resolveMakerfarmCoords(env = process.env) {
  if (cachedMakerfarm) return cachedMakerfarm;
  const latRaw = Number(env.TASK_MAKERFARM_LAT);
  const lonRaw = Number(env.TASK_MAKERFARM_LON);
  if (Number.isFinite(latRaw) && Number.isFinite(lonRaw)) {
    cachedMakerfarm = { lat: latRaw, lon: lonRaw };
    return cachedMakerfarm;
  }
  const geo = await geocodeAddress('Bay Area Maker Farm, Alameda, CA');
  if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
    cachedMakerfarm = { lat: geo.lat, lon: geo.lon };
    return cachedMakerfarm;
  }
  return null;
}

async function resolveHomeCoords(env = process.env) {
  try {
    const addr = await loadRainAlertAddress();
    const geo = await geocodeAddress(addr);
    if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
      return { lat: geo.lat, lon: geo.lon };
    }
  } catch {
    /* fall through */
  }
  const hero = await resolveDashboardWeatherLatLon(env);
  if (Number.isFinite(hero.lat) && Number.isFinite(hero.lon)) {
    return { lat: hero.lat, lon: hero.lon };
  }
  return null;
}

function resolvePlaceKind(lat, lon, home, makerfarm) {
  if (home && haversineMiles(lat, lon, home.lat, home.lon) <= HOME_RADIUS_MI) return 'home';
  if (makerfarm && haversineMiles(lat, lon, makerfarm.lat, makerfarm.lon) <= MAKERFARM_RADIUS_MI) {
    return 'makerfarm';
  }
  return 'out';
}

function resolveTimeKind(timeZone) {
  const tz = String(timeZone || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  if (isWeekend) return 'weekend';
  if (Number.isFinite(hour) && hour >= 9 && hour < 17) return 'weekday_9_5';
  return 'afterhours';
}

export async function resolveTaskContext(opts = {}, env = process.env) {
  const deviceRaw = String(opts.device || 'laptop').trim().toLowerCase();
  const device = deviceRaw === 'phone' || deviceRaw === 'mobile' ? 'phone' : 'laptop';
  const timeZone =
    String(opts.timeZone || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles';
  const home = await resolveHomeCoords(env);
  const makerfarm = await resolveMakerfarmCoords(env);

  let lat = Number(opts.lat);
  let lon = Number(opts.lon);
  let placeKind = 'home';
  let gps = false;

  if (Number.isFinite(lat) && Number.isFinite(lon) && (Math.abs(lat) > 1e-6 || Math.abs(lon) > 1e-6)) {
    gps = true;
    placeKind = resolvePlaceKind(lat, lon, home, makerfarm);
  } else if (home) {
    lat = home.lat;
    lon = home.lon;
    placeKind = 'home';
  }

  const allowedLocations = [];
  if (placeKind === 'home') {
    allowedLocations.push('home', 'phone');
    if (device === 'laptop') allowedLocations.push('laptop');
  } else if (placeKind === 'makerfarm') {
    allowedLocations.push('makerfarm', 'phone');
  } else {
    allowedLocations.push('out', 'phone');
  }
  if (device === 'laptop' && !allowedLocations.includes('laptop')) allowedLocations.push('laptop');

  const timeKind = resolveTimeKind(timeZone);
  const allowedTimes = [];
  if (timeKind === 'weekend') {
    allowedTimes.push('weekend', 'afterhours');
  } else if (timeKind === 'weekday_9_5') {
    allowedTimes.push('weekday_9_5');
  } else {
    allowedTimes.push('afterhours');
  }

  const placeLabels = { home: 'Home', makerfarm: 'Maker Farm', out: 'Out and about' };

  return {
    device,
    gps,
    placeKind,
    timeKind,
    timeZone,
    allowedLocations: [...new Set(allowedLocations)],
    allowedTimes,
    label: [
      placeLabels[placeKind],
      TIME_LABELS[timeKind] || timeKind,
      device === 'phone' ? 'Phone' : 'Laptop',
    ].join(' · '),
  };
}

export function effectiveTaskLocations(taskMeta, projectMeta) {
  if (taskMeta?.locationAny) return [];
  if (taskMeta?.location) return [taskMeta.location];
  if (taskMeta?.locations?.length) return taskMeta.locations;
  if (projectMeta?.location) return [projectMeta.location];
  return [];
}

export function effectiveTaskTimes(taskMeta) {
  if (taskMeta?.timeAny) return [];
  return taskMeta?.times?.length ? taskMeta.times : [];
}

function overlaps(have, allowed) {
  if (!have.length) return true;
  return have.some((x) => allowed.includes(x));
}

/**
 * True when the task is tagged for laptop only (not phone-ok / home / etc.).
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
function isLaptopOnlyTask(taskMeta, projectMeta) {
  const locs = effectiveTaskLocations(taskMeta, projectMeta);
  return locs.length > 0 && locs.every((loc) => loc === 'laptop');
}

export function taskMatchesRandomFilters(taskMeta, projectMeta, filters, context) {
  if (filters.difficulty) {
    const want = normalizeDifficulty(filters.difficulty);
    if (want && taskMeta?.difficulty && taskMeta.difficulty !== want) return false;
  }
  if (filters.duration) {
    const budget = normalizeDuration(filters.duration);
    if (budget && taskMeta?.duration) {
      const taskTier = DURATION_TIER[taskMeta.duration];
      const budgetTier = DURATION_TIER[budget];
      if (taskTier > budgetTier) return false;
    }
  }
  if (context.device === 'phone' && isLaptopOnlyTask(taskMeta, projectMeta)) return false;
  const locs = effectiveTaskLocations(taskMeta, projectMeta);
  if (!overlaps(locs, context.allowedLocations)) return false;
  const times = effectiveTaskTimes(taskMeta);
  if (!overlaps(times, context.allowedTimes)) return false;
  return true;
}

export function missingTaskMetaFields(taskMeta, projectMeta) {
  const missing = [];
  if (!taskMeta?.priority) missing.push('priority');
  if (!taskMeta?.difficulty) missing.push('difficulty');
  if (!taskMeta?.duration) missing.push('duration');
  if (!effectiveTaskLocations(taskMeta, projectMeta).length) missing.push('locations');
  if (!taskMeta?.timeAny && !effectiveTaskTimes(taskMeta).length) missing.push('times');
  return missing;
}

/**
 * @param {Array<{ id: string }>} pool
 * @param {import('./task-random-meta-store.js').TaskRandomMeta['byTaskId']} byTaskId
 */
function pickWeightedTask(pool, byTaskId) {
  if (pool.length === 1) return pool[0];
  let total = 0;
  const weights = pool.map((t) => {
    const pri = byTaskId[String(t.id)]?.priority;
    const w = pri && PRIORITY_WEIGHT[pri] ? PRIORITY_WEIGHT[pri] : 1;
    total += w;
    return w;
  });
  let roll = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

export function pickRandomTask(tasks, meta, filters, context) {
  const exclude = new Set((filters.excludeIds || []).map((x) => String(x)));
  const excludeProjects = new Set((filters.excludeProjectIds || []).map((x) => String(x)));
  const pool = tasks.filter((t) => {
    if (exclude.has(String(t.id))) return false;
    if (t.projectId != null && excludeProjects.has(String(t.projectId))) return false;
    const taskMeta = meta.byTaskId[String(t.id)] || null;
    const projectMeta = t.projectId != null ? meta.byProjectId[String(t.projectId)] || null : null;
    return taskMatchesRandomFilters(taskMeta, projectMeta, filters, context);
  });
  if (!pool.length) return { task: null, poolSize: 0 };
  const task = pickWeightedTask(pool, meta.byTaskId);
  const taskMeta = meta.byTaskId[String(task.id)] || null;
  const projectMeta = task.projectId != null ? meta.byProjectId[String(task.projectId)] || null : null;
  return {
    task,
    poolSize: pool.length,
    meta: taskMeta,
    projectMeta,
    missingFields: missingTaskMetaFields(taskMeta, projectMeta),
    effectiveLocations: effectiveTaskLocations(taskMeta, projectMeta),
  };
}

export { DIFFICULTY_LABELS, DURATION_LABELS, LOCATION_LABELS, TIME_LABELS };
