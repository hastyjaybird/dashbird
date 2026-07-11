/**
 * Telegram Events intake status (bot + allowlist + OpenRouter).
 */
import { Router } from 'express';
import {
  probeTelegramEventsIntake,
  telegramAllowedChatIds,
  telegramBotToken,
  telegramEventsEnabled,
} from '../lib/events-finder-telegram.js';

const router = Router();

/**
 * GET /api/events-finder/telegram/status
 */
router.get('/status', async (_req, res) => {
  try {
    const probe = await probeTelegramEventsIntake();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      enabled: telegramEventsEnabled(),
      tokenConfigured: Boolean(telegramBotToken()),
      allowedChatIds: [...telegramAllowedChatIds()],
      probe,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
