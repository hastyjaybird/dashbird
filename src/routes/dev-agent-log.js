import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();
router.use(express.json({ limit: '64kb' }));

/**
 * @param {Record<string, unknown>} payload
 */
async function writeAgentLog(payload) {
  const sid = String(payload.sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
  const line = `${JSON.stringify(payload)}\n`;
  const dataLogPath = path.resolve(__dirname, `../../data/debug-${sid}.ndjson`);
  const cursorLogPath = path.resolve(__dirname, `../../.cursor/debug-${sid}.log`);
  await mkdir(path.dirname(dataLogPath), { recursive: true });
  await appendFile(dataLogPath, line, 'utf8');
  try {
    await mkdir(path.dirname(cursorLogPath), { recursive: true });
    await appendFile(cursorLogPath, line, 'utf8');
  } catch {
    // .cursor may be image-only / not writable; data/ mirror is enough.
  }
  for (const url of [
    'http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22',
    'http://172.17.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22',
  ]) {
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': sid,
      },
      body: line,
    }).catch(() => {});
  }
}

/**
 * Debug-session ingest so LAN/phone clients can log without reaching 127.0.0.1:7876.
 * POST body: arbitrary JSON object (one NDJSON line). Uses sessionId for log file names.
 */
router.post('/', async (req, res) => {
  try {
    const payload = {
      ...(req.body && typeof req.body === 'object' ? req.body : { raw: req.body }),
      receivedAt: Date.now(),
      via: 'api/dev-agent-log',
    };
    await writeAgentLog(payload);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** Image / sendBeacon fallback (GET) — Firefox may delay POST fetch. */
router.get('/', async (req, res) => {
  try {
    const q = req.query || {};
    await writeAgentLog({
      sessionId: String(q.sid || '7a319b'),
      runId: 'phone-stall-6',
      hypothesisId: String(q.hid || 'beacon'),
      location: String(q.loc || 'beacon'),
      message: String(q.msg || 'img-beacon'),
      data: { method: 'GET', ua: String(req.get('user-agent') || '').slice(0, 160) },
      timestamp: Number(q.t) || Date.now(),
      receivedAt: Date.now(),
      via: 'api/dev-agent-log-get',
    });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;
