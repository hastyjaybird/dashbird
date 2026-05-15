import { Router } from 'express';
import express from 'express';
import { Readable } from 'node:stream';

const router = Router();
router.use(express.json({ limit: '512kb' }));

/** Simple per-IP sliding window (1 minute). Set CHAT_RATE_LIMIT_PER_MINUTE=0 to disable. */
const rlBuckets = new Map();

function checkChatRateLimit(ip, maxPerMin) {
  if (maxPerMin <= 0) return true;
  const now = Date.now();
  const key = ip || 'local';
  let b = rlBuckets.get(key);
  if (!b || now - b.windowStart >= 60_000) {
    b = { windowStart: now, count: 0 };
    rlBuckets.set(key, b);
  }
  b.count += 1;
  return b.count <= maxPerMin;
}

router.post('/', async (req, res) => {
  const raw = process.env.CHAT_RATE_LIMIT_PER_MINUTE;
  let maxPerMin = raw === undefined || raw === '' ? 0 : parseInt(raw, 10);
  if (!Number.isFinite(maxPerMin) || maxPerMin < 0) maxPerMin = 0;
  if (!checkChatRateLimit(req.ip, maxPerMin)) {
    res.status(429).json({
      error: 'rate_limited',
      detail: 'Too many chat requests from this host. Wait up to a minute or raise CHAT_RATE_LIMIT_PER_MINUTE.',
    });
    return;
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    res.status(503).json({
      error: 'openrouter_not_configured',
      detail: 'Set OPENROUTER_API_KEY in .env',
    });
    return;
  }

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'invalid_body', detail: 'Expected { messages: [...] }' });
    return;
  }

  const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';

  let upstream;
  try {
    upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
        'X-Title': 'dashbird',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
      }),
    });
  } catch (e) {
    res.status(502).json({ error: 'openrouter_fetch_failed', detail: String(e.message) });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const nodeReadable = Readable.fromWeb(upstream.body);
  nodeReadable.on('error', () => res.end());
  res.on('close', () => nodeReadable.destroy());
  nodeReadable.pipe(res);
});

export default router;
