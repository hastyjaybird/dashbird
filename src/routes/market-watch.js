import { Router } from 'express';
import express from 'express';
import { fetchCnnFearGreedIndex } from '../lib/fear-greed-index.js';
import { fetchMarketWatchQuotes } from '../lib/market-watch-quotes.js';
import {
  QUOTE_RANGE_OPTIONS,
  loadMarketWatchSettings,
  saveMarketWatchSettings,
} from '../lib/market-watch-settings.js';
import {
  loadMarketWatchTickerList,
  saveMarketWatchTickerList,
} from '../lib/market-watch-tickers.js';

const router = Router();
router.use(express.json({ limit: '32kb' }));

function marketWatchDisabled() {
  return String(process.env.MARKET_WATCH || '').trim() === '0';
}

router.get('/settings', async (_req, res) => {
  try {
    if (marketWatchDisabled()) {
      res.json({ ok: true, disabled: true, settings: null });
      return;
    }
    const settings = await loadMarketWatchSettings();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      settings,
      options: { quoteRange: QUOTE_RANGE_OPTIONS },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/settings', async (req, res) => {
  try {
    if (marketWatchDisabled()) {
      res.status(400).json({ ok: false, error: 'market_watch_disabled' });
      return;
    }
    const saved = await saveMarketWatchSettings(req.body?.settings ?? req.body);
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, settings: saved.settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/tickers', async (_req, res) => {
  try {
    if (marketWatchDisabled()) {
      res.json({ ok: true, disabled: true, tickers: [] });
      return;
    }
    const tickers = await loadMarketWatchTickerList();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, tickers });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/tickers', async (req, res) => {
  try {
    if (marketWatchDisabled()) {
      res.status(400).json({ ok: false, error: 'market_watch_disabled' });
      return;
    }
    const saved = await saveMarketWatchTickerList(req.body?.tickers);
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, tickers: saved.tickers });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/fear-greed', async (_req, res) => {
  try {
    if (marketWatchDisabled()) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, fearGreed: { ok: false, error: 'disabled' } });
      return;
    }
    const fearGreed = await fetchCnnFearGreedIndex();
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({
      ok: true,
      fearGreed:
        fearGreed.ok || fearGreed.stale ? fearGreed : { ok: false, error: fearGreed.error },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/', async (_req, res) => {
  try {
    if (marketWatchDisabled()) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, tickers: [] });
      return;
    }

    const payload = await fetchMarketWatchQuotes();
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.json({ ok: true, ...payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
