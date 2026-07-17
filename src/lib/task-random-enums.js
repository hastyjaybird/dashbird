/** @typedef {'low' | 'med' | 'high'} TaskDifficulty */
/** @typedef {'5m' | '15m' | '30m' | '1hr+'} TaskDuration */
/** @typedef {'home' | 'out' | 'makerfarm' | 'laptop' | 'phone'} TaskLocation */
/** @typedef {'weekday_9_5' | 'afterhours' | 'weekend'} TaskTime */

export const TASK_DIFFICULTIES = /** @type {const} */ (['low', 'med', 'high']);
export const TASK_DURATIONS = /** @type {const} */ (['5m', '15m', '30m', '1hr+']);
export const TASK_LOCATIONS = /** @type {const} */ (['home', 'out', 'makerfarm', 'laptop', 'phone']);
export const TASK_TIMES = /** @type {const} */ (['weekday_9_5', 'afterhours', 'weekend']);

/** @type {Record<TaskDuration, number>} */
export const DURATION_TIER = { '5m': 1, '15m': 2, '30m': 3, '1hr+': 4 };

/** @type {Record<TaskLocation, string>} */
export const LOCATION_LABELS = {
  home: 'Home',
  out: 'Out and about',
  makerfarm: 'Maker Farm',
  laptop: 'Laptop only',
  phone: 'Phone ok',
};

/** @type {Record<TaskDifficulty, string>} */
export const DIFFICULTY_LABELS = { low: 'Low', med: 'Med', high: 'High' };

/** @type {Record<TaskDuration, string>} */
export const DURATION_LABELS = { '5m': '5 min', '15m': '15 min', '30m': '30 min', '1hr+': '1 hr+' };

/** @type {Record<TaskTime, string>} */
export const TIME_LABELS = {
  weekday_9_5: 'Weekday 9–5',
  afterhours: 'After hours ok',
  weekend: 'Weekend',
};

export function normalizeDifficulty(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'medium') return 'med';
  return TASK_DIFFICULTIES.includes(/** @type {TaskDifficulty} */ (s)) ? /** @type {TaskDifficulty} */ (s) : null;
}

export function normalizeDuration(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (s === '1h+' || s === '1hr' || s === '60m') return '1hr+';
  return TASK_DURATIONS.includes(/** @type {TaskDuration} */ (s)) ? /** @type {TaskDuration} */ (s) : null;
}

export function normalizeLocation(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (s === 'makerfarm' || s === 'maker-farm' || s === 'makerfarm') return 'makerfarm';
  if (s === 'outandabout' || s === 'out-and-about') return 'out';
  if (s === 'laptoponly' || s === 'laptop-only') return 'laptop';
  if (s === 'phoneok' || s === 'phone-ok') return 'phone';
  return TASK_LOCATIONS.includes(/** @type {TaskLocation} */ (s)) ? /** @type {TaskLocation} */ (s) : null;
}

export function normalizeLocations(raw) {
  if (Array.isArray(raw)) {
    const out = [];
    for (const x of raw) {
      const v = normalizeLocation(x);
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  }
  const one = normalizeLocation(raw);
  return one ? [one] : [];
}

export function normalizeTime(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (s === 'weekday' || s === 'weekday_9-5' || s === '9-5' || s === 'business') return 'weekday_9_5';
  if (s === 'afterhours' || s === 'after_hours' || s === 'evening') return 'afterhours';
  return TASK_TIMES.includes(/** @type {TaskTime} */ (s)) ? /** @type {TaskTime} */ (s) : null;
}

export function normalizeTimes(raw) {
  if (Array.isArray(raw)) {
    const out = [];
    for (const x of raw) {
      const v = normalizeTime(x);
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  }
  const one = normalizeTime(raw);
  return one ? [one] : [];
}
