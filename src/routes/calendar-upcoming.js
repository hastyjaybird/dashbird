import { Router } from 'express';
import { fetchUpcomingGoogleCalendarEvents } from '../lib/google-calendar-ical.js';

const router = Router();

/** GET /api/calendar/upcoming — next events from Google Calendar iCal feed */
router.get('/upcoming', async (req, res) => {
  try {
    const result = await fetchUpcomingGoogleCalendarEvents();
    if (result.ok && result.cached) {
      res.setHeader('Cache-Control', result.stale ? 'private, max-age=30' : 'private, max-age=120');
    } else {
      res.setHeader('Cache-Control', 'private, no-cache');
    }
    res.json(result);
  } catch (e) {
    const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    res.status(502).json({ ok: false, error: msg, events: [] });
  }
});

export default router;
