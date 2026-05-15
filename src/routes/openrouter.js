import { Router } from 'express';

const router = Router();

/** GET /api/openrouter/credits — management key may be required. */
router.get('/credits', async (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    res.status(503).json({ ok: false, error: 'openrouter_not_configured' });
    return;
  }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    if (!r.ok) {
      res.status(r.status).json({
        ok: false,
        status: r.status,
        error: body?.error?.message || body?.error || text.slice(0, 200),
      });
      return;
    }
    const d = body?.data;
    if (!d || typeof d.total_credits !== 'number' || typeof d.total_usage !== 'number') {
      res.json({ ok: true, data: d ?? body });
      return;
    }
    const remaining = Math.max(0, d.total_credits - d.total_usage);
    const pct =
      d.total_credits > 0 ? Math.round((remaining / d.total_credits) * 1000) / 10 : null;
    res.json({
      ok: true,
      data: {
        total_credits: d.total_credits,
        total_usage: d.total_usage,
        remaining,
        remaining_percent: pct,
      },
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message) });
  }
});

/**
 * GET /api/openrouter/key — proxy current key info (often works with the same key used for chat).
 * Shape varies; see https://openrouter.ai/docs
 */
router.get('/key', async (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    res.status(503).json({ ok: false, error: 'openrouter_not_configured' });
    return;
  }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    res.status(r.status).json({ ok: r.ok, status: r.status, data: body });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message) });
  }
});

/**
 * GET /api/openrouter/summary — best-effort monthly % remaining, else purchased-credit pool %.
 */
router.get('/summary', async (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    res.status(503).json({ ok: false, error: 'openrouter_not_configured' });
    return;
  }

  try {
    const keyRes = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (keyRes.ok) {
      const body = await keyRes.json();
      const d = body?.data ?? body;
      const limit =
        typeof d.limit === 'number' && !Number.isNaN(d.limit) ? d.limit : null;
      const usageMonthly =
        typeof d.usage_monthly === 'number' && !Number.isNaN(d.usage_monthly)
          ? d.usage_monthly
          : null;
      const limitRemaining =
        typeof d.limit_remaining === 'number' && !Number.isNaN(d.limit_remaining)
          ? d.limit_remaining
          : null;
      const limitReset =
        typeof d.limit_reset === 'string' && d.limit_reset.trim()
          ? d.limit_reset.trim().toLowerCase()
          : null;

      const periodWord =
        limitReset === 'monthly'
          ? 'monthly'
          : limitReset === 'weekly'
            ? 'weekly'
            : limitReset === 'daily'
              ? 'daily'
              : 'spend';

      if (limit != null && limit > 0 && usageMonthly != null) {
        const used = Math.min(usageMonthly, limit);
        const pct = Math.round(((limit - used) / limit) * 1000) / 10;
        res.json({
          ok: true,
          source: 'key',
          monthly_percent_remaining: pct,
          limit,
          usage_monthly: usageMonthly,
          limit_reset: limitReset,
          label: `${periodWord} limit (OpenRouter key)`,
        });
        return;
      }

      if (limit != null && limit > 0 && limitRemaining != null) {
        const pct = Math.round((Math.max(0, limitRemaining) / limit) * 1000) / 10;
        res.json({
          ok: true,
          source: 'key',
          monthly_percent_remaining: pct,
          limit,
          limit_remaining: limitRemaining,
          limit_reset: limitReset,
          label: `Remaining vs ${periodWord} limit (OpenRouter)`,
        });
        return;
      }
    }

    const credRes = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const credText = await credRes.text();
    let credBody;
    try {
      credBody = JSON.parse(credText);
    } catch {
      credBody = { raw: credText };
    }
    if (!credRes.ok) {
      res.status(credRes.status).json({
        ok: false,
        error: credBody?.error?.message || credBody?.error || credText.slice(0, 200),
      });
      return;
    }
    const cd = credBody?.data;
    if (cd && typeof cd.total_credits === 'number' && typeof cd.total_usage === 'number') {
      const remaining = Math.max(0, cd.total_credits - cd.total_usage);
      const pct =
        cd.total_credits > 0 ? Math.round((remaining / cd.total_credits) * 1000) / 10 : null;
      res.json({
        ok: true,
        source: 'credits',
        monthly_percent_remaining: pct,
        label: 'Purchased credits remaining (not calendar-month)',
        total_credits: cd.total_credits,
        total_usage: cd.total_usage,
        remaining,
      });
      return;
    }

    res.json({ ok: true, source: 'credits_raw', raw: credBody });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message) });
  }
});

export default router;
