/**
 * Market Watch ticker list (read/write). Live file under data/; seeds from src/data on first use.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SEED_PATH = path.join(PKG_ROOT, 'src/data/market-watch-tickers.json');

export function marketWatchTickersPath(env = process.env) {
  const override = String(env.MARKET_WATCH_TICKERS_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/market-watch-tickers.json');
}

const MAX_TICKERS = 24;
const SYMBOL_RE = /^[A-Z0-9^=\-.]{1,16}$/;

/**
 * @param {{ label?: string, symbol?: string }} raw
 */
export function normalizeMarketWatchTicker(raw) {
  const symbol = String(raw?.symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!symbol || !SYMBOL_RE.test(symbol)) {
    return { ok: false, error: 'invalid_symbol' };
  }
  let label = String(raw?.label ?? '')
    .trim()
    .toUpperCase();
  if (!label) label = symbol;
  if (label.length > 32) label = label.slice(0, 32);
  return { ok: true, label, symbol };
}

/**
 * @param {unknown} list
 */
export function normalizeMarketWatchTickerList(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'tickers_must_be_array' };
  if (list.length > MAX_TICKERS) return { ok: false, error: 'too_many_tickers' };
  /** @type {Array<{ label: string, symbol: string }>} */
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const n = normalizeMarketWatchTicker(raw);
    if (!n.ok) return { ok: false, error: n.error };
    if (seen.has(n.symbol)) return { ok: false, error: 'duplicate_symbol' };
    seen.add(n.symbol);
    out.push({ label: n.label, symbol: n.symbol });
  }
  return { ok: true, tickers: out };
}

async function ensureTickerFile() {
  const live = marketWatchTickersPath();
  try {
    await fs.access(live);
    return live;
  } catch {
    await fs.mkdir(path.dirname(live), { recursive: true });
    try {
      await fs.copyFile(SEED_PATH, live);
    } catch {
      await fs.writeFile(live, JSON.stringify({ tickers: [] }, null, 2) + '\n', 'utf8');
    }
    return live;
  }
}

/** Invalidate in-memory quote config cache (market-watch-quotes.js). */
let onSaveHook = () => {};

export function setMarketWatchTickersSaveHook(fn) {
  onSaveHook = typeof fn === 'function' ? fn : () => {};
}

/**
 * @returns {Promise<Array<{ label: string, symbol: string }>>}
 */
export async function loadMarketWatchTickerList() {
  const live = await ensureTickerFile();
  const raw = await fs.readFile(live, 'utf8');
  const j = JSON.parse(raw);
  const normalized = normalizeMarketWatchTickerList(j.tickers || []);
  return normalized.ok ? normalized.tickers : [];
}

/**
 * @param {Array<{ label?: string, symbol?: string }>} tickers
 */
export async function saveMarketWatchTickerList(tickers) {
  const normalized = normalizeMarketWatchTickerList(tickers);
  if (!normalized.ok) return normalized;

  const live = await ensureTickerFile();
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify({ tickers: normalized.tickers }, null, 2)}\n`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, live);
  onSaveHook();
  return { ok: true, tickers: normalized.tickers };
}
