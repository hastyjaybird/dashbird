import { fetchCnnFearGreedIndex } from './fear-greed-index.js';
import {
  invalidateMarketWatchSettingsCache,
  loadMarketWatchSettings,
  quoteRangeConfig,
} from './market-watch-settings.js';
import { loadMarketWatchTickerList, setMarketWatchTickersSaveHook } from './market-watch-tickers.js';

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const FETCH_TIMEOUT_MS = 12_000;

/** @type {Promise<Array<{ label: string, symbol: string }>> | null} */
let tickerListPromise = null;

function invalidateTickerCache() {
  tickerListPromise = null;
}

setMarketWatchTickersSaveHook(invalidateTickerCache);

async function getTickerList() {
  if (!tickerListPromise) tickerListPromise = loadMarketWatchTickerList();
  return tickerListPromise;
}

export async function loadMarketWatchTickers() {
  const tickers = await getTickerList();
  return { tickers };
}

/**
 * @param {string} symbol
 * @param {{ yahooRange: string, interval: string, quoteRange: string }} rangeCfg
 */
async function fetchYahooQuote(symbol, rangeCfg) {
  const url = new URL(`${YAHOO_CHART}/${encodeURIComponent(symbol)}`);
  url.searchParams.set('interval', rangeCfg.interval);
  url.searchParams.set('range', rangeCfg.yahooRange);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: ac.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Dashbird/1.0 (market-watch; local dashboard)',
      },
    });
    if (!res.ok) return { symbol, ok: false, error: `http_${res.status}` };
    const doc = await res.json();
    const result = doc?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return { symbol, ok: false, error: 'no_meta' };

    const price = Number(meta.regularMarketPrice ?? meta.previousClose);
    if (!Number.isFinite(price)) return { symbol, ok: false, error: 'no_price' };

    const rawCloses = result?.indicators?.quote?.[0]?.close;
    /** @type {number[]} */
    const sparkline = Array.isArray(rawCloses)
      ? rawCloses
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v) && v > 0)
      : [];

    let prev = Number(meta.chartPreviousClose ?? meta.previousClose ?? price);
    if (rangeCfg.quoteRange !== '5d' && sparkline.length >= 2) {
      prev = sparkline[0];
    } else if (rangeCfg.quoteRange !== '5d' && sparkline.length === 1) {
      prev = sparkline[0];
    }

    const change = Number.isFinite(prev) ? price - prev : null;
    const changePct =
      change != null && Number.isFinite(prev) && prev !== 0 ? (change / prev) * 100 : null;

    const currency =
      typeof meta.currency === 'string' && meta.currency.trim() !== '' ? meta.currency.trim() : 'USD';

    return {
      symbol,
      ok: true,
      price,
      change,
      changePct,
      sparkline,
      quoteRange: rangeCfg.quoteRange,
      currency,
      shortName:
        typeof meta.shortName === 'string' && meta.shortName.trim() !== ''
          ? meta.shortName.trim()
          : symbol,
      marketUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    };
  } catch (e) {
    const msg =
      e && typeof e === 'object' && 'name' in e && e.name === 'AbortError' ? 'timeout' : 'fetch_failed';
    return { symbol, ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMarketWatchQuotes() {
  const [tickerList, fearGreed, settings] = await Promise.all([
    getTickerList(),
    fetchCnnFearGreedIndex(),
    loadMarketWatchSettings(),
  ]);
  const rangeCfg = quoteRangeConfig(settings.quoteRange);
  const results = await Promise.all(
    tickerList.map(async ({ label, symbol }) => {
      const q = await fetchYahooQuote(symbol, rangeCfg);
      return { label, ...q };
    }),
  );
  return {
    tickers: results,
    fearGreed: fearGreed.ok || fearGreed.stale ? fearGreed : { ok: false, error: fearGreed.error },
    settings,
    fetchedAt: new Date().toISOString(),
  };
}
