import { Router } from 'express';

const router = Router();
router.use(requireJsonBody);

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

router.get('/health', (_req, res) => {
  const hasKey = Boolean(String(process.env.OPENROUTER_API_KEY || '').trim());
  res.json({
    ok: true,
    provider: 'openrouter',
    configured: hasKey,
    baseUrl: OPENROUTER_BASE,
  });
});

router.post('/chat/completions', async (req, res) => {
  const key = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!key) {
    res.status(503).json({ ok: false, error: 'openrouter_not_configured' });
    return;
  }
  const body = req.body || {};
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ ok: false, error: 'messages_required' });
    return;
  }

  try {
    const model = String(body.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini');
    const upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
        'X-Title': process.env.OPENROUTER_X_TITLE || 'dashbird-openrouter-proxy',
      },
      body: JSON.stringify({
        ...body,
        model,
      }),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
});

function requireJsonBody(req, _res, next) {
  // src/server.js already has express.json use for most routes; this keeps
  // this module robust if it is mounted in isolation in the future.
  if (typeof req.body === 'undefined') req.body = {};
  next();
}

export default router;
