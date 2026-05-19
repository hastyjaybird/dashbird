/**
 * Market Watch UI settings (quote range, Fear & Greed horizon display).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SEED_PATH = path.join(PKG_ROOT, 'src/data/market-watch-settings.json');

export const QUOTE_RANGE_OPTIONS = [
  { id: '5d', label: '5 days', yahooRange: '5d', interval: '1d' },
  { id: '1mo', label: '1 month', yahooRange: '1mo', interval: '1d' },
  { id: '3mo', label: '3 months', yahooRange: '3mo', interval: '1d' },
  { id: '6mo', label: '6 months', yahooRange: '6mo', interval: '1d' },
  { id: '1y', label: '1 year', yahooRange: '1y', interval: '1d' },
  { id: 'ytd', label: 'Year to date', yahooRange: 'ytd', interval: '1d' },
];

export const FNG_HORIZON_OPTIONS = [
  { id: 'all', label: 'All horizons' },
  { id: 'previous_close', label: 'Previous close', field: 'previousClose' },
  { id: '1_week', label: '1 week ago', field: 'previous1Week' },
  { id: '1_month', label: '1 month ago', field: 'previous1Month' },
  { id: '1_year', label: '1 year ago', field: 'previous1Year' },
];

const DEFAULT_SETTINGS = {
  quoteRange: '5d',
  fearGreedHorizon: 'all',
};

export function marketWatchSettingsPath(env = process.env) {
  const override = String(env.MARKET_WATCH_SETTINGS_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/market-watch-settings.json');
}

/**
 * @param {unknown} raw
 */
export function normalizeMarketWatchSettings(raw) {
  const quoteRange = String(raw?.quoteRange || DEFAULT_SETTINGS.quoteRange).trim();
  const fearGreedHorizon = String(raw?.fearGreedHorizon || DEFAULT_SETTINGS.fearGreedHorizon).trim();

  const quoteOk = QUOTE_RANGE_OPTIONS.some((o) => o.id === quoteRange);
  const fngOk = FNG_HORIZON_OPTIONS.some((o) => o.id === fearGreedHorizon);

  return {
    ok: true,
    settings: {
      quoteRange: quoteOk ? quoteRange : DEFAULT_SETTINGS.quoteRange,
      fearGreedHorizon: fngOk ? fearGreedHorizon : DEFAULT_SETTINGS.fearGreedHorizon,
    },
  };
}

/**
 * @param {string} id
 */
export function quoteRangeConfig(id) {
  return QUOTE_RANGE_OPTIONS.find((o) => o.id === id) || QUOTE_RANGE_OPTIONS[0];
}

async function ensureSettingsFile() {
  const live = marketWatchSettingsPath();
  try {
    await fs.access(live);
    return live;
  } catch {
    await fs.mkdir(path.dirname(live), { recursive: true });
    try {
      await fs.copyFile(SEED_PATH, live);
    } catch {
      await fs.writeFile(live, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, 'utf8');
    }
    return live;
  }
}

/** @type {Promise<{ quoteRange: string, fearGreedHorizon: string }> | null} */
let settingsPromise = null;

export function invalidateMarketWatchSettingsCache() {
  settingsPromise = null;
}

/**
 * @returns {Promise<{ quoteRange: string, fearGreedHorizon: string }>}
 */
export async function loadMarketWatchSettings() {
  if (!settingsPromise) {
    settingsPromise = (async () => {
      const live = await ensureSettingsFile();
      const raw = await fs.readFile(live, 'utf8');
      const j = JSON.parse(raw);
      const normalized = normalizeMarketWatchSettings(j);
      return normalized.settings;
    })();
  }
  return settingsPromise;
}

/**
 * @param {unknown} patch
 */
export async function saveMarketWatchSettings(patch) {
  const current = await loadMarketWatchSettings();
  const merged = normalizeMarketWatchSettings({ ...current, ...patch });
  if (!merged.ok) return merged;

  const live = await ensureSettingsFile();
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(merged.settings, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, live);
  invalidateMarketWatchSettingsCache();
  return { ok: true, settings: merged.settings };
}
