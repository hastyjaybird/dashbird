import { Router } from 'express';
import {
  formatMoonbowWindowMdRangeForWall,
  loadYosemiteMoonbowConfig,
  pickActiveMoonbowWindow,
  wallYmdInTimeZone,
} from '../lib/yosemite-moonbow.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const off = String(process.env.EARTH_YOSEMITE_MOONBOW || '').trim() === '0';
    if (off) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, items: [] });
      return;
    }

    const cfg = await loadYosemiteMoonbowConfig();
    if (!cfg || cfg.windows.length === 0) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, items: [], itemCount: 0 });
      return;
    }

    const timeZone = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
    const now = new Date();
    const wallYmd = wallYmdInTimeZone(now, timeZone);
    const win = pickActiveMoonbowWindow({ wallYmd, windows: cfg.windows });

    if (!win) {
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.json({
        ok: true,
        timeZone,
        wallYmd,
        itemCount: 0,
        items: [],
      });
      return;
    }

    const detailLine = formatMoonbowWindowMdRangeForWall(wallYmd, win.start, win.end);

    const items = [
      {
        earthType: 'yosemite_moonbow',
        label: 'Yosemite moonbow',
        detailLine,
        forecastUrl: cfg.referenceUrl || 'https://www.yosemitemoonbow.com/',
        moonbow: {
          windowStart: win.start,
          windowEnd: win.end,
          wallYmd,
        },
      },
    ];

    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({
      ok: true,
      timeZone,
      wallYmd,
      itemCount: items.length,
      items,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
