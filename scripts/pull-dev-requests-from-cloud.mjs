#!/usr/bin/env node
/**
 * Pull dev-requests from Dashbird cloud into data/dev-requests/ (+ rebuild inbox).
 *
 * HTTPS (cloud agents, no SSH):
 *   DASHBOARD_CLOUD_URL=https://dashbird.jayhasty.com \
 *   DASHBOARD_BASIC_AUTH_USER=dashbird \
 *   DASHBOARD_BASIC_AUTH_PASSWORD=... \
 *   node scripts/pull-dev-requests-from-cloud.mjs
 *
 * SSH/rsync (LAN laptop with CLOUD_HOST in .env):
 *   ./scripts/pull-dev-requests-from-cloud.sh
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildDevRequestsIndex } from '../src/lib/dev-requests-store.js';

const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLOUD_URL = String(process.env.DASHBOARD_CLOUD_URL || 'https://dashbird.jayhasty.com').replace(/\/$/, '');
const AUTH_USER = String(process.env.DASHBOARD_BASIC_AUTH_USER || '').trim();
const AUTH_PASS = String(process.env.DASHBOARD_BASIC_AUTH_PASSWORD || process.env.DASHBOARD_BASIC_AUTH_PASS || '').trim();

function authHeader() {
  if (!AUTH_USER || !AUTH_PASS) {
    console.error('[dashbird] Set DASHBOARD_BASIC_AUTH_USER and DASHBOARD_BASIC_AUTH_PASSWORD');
    process.exit(1);
  }
  const token = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
  return `Basic ${token}`;
}

/** @param {string} urlPath */
async function cloudFetch(urlPath) {
  const r = await fetch(`${CLOUD_URL}${urlPath}`, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    redirect: 'follow',
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${urlPath} → HTTP ${r.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return r;
}

/** @param {string} status */
async function listRequests(status) {
  const r = await cloudFetch(`/api/dev-requests?status=${encodeURIComponent(status)}`);
  const data = await r.json();
  if (!data?.ok || !Array.isArray(data.requests)) {
    throw new Error(`unexpected list response for status=${status}`);
  }
  return data.requests;
}

/** @param {string} id @param {string} filename */
async function downloadAttachment(id, filename) {
  const r = await cloudFetch(`/api/dev-requests/${encodeURIComponent(id)}/files/${encodeURIComponent(filename)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  console.log(`[dashbird] Pulling dev-requests from ${CLOUD_URL}`);
  const statuses = ['open', 'done'];
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map();
  for (const status of statuses) {
    const rows = await listRequests(status);
    for (const req of rows) {
      if (req?.id) byId.set(String(req.id), req);
    }
  }
  const requests = [...byId.values()];
  console.log(`[dashbird] Found ${requests.length} request(s) (open + done)`);

  const root = path.join(ROOT, 'data', 'dev-requests');
  await mkdir(root, { recursive: true });

  for (const req of requests) {
    const folder = String(req.folder || '').trim();
    if (!folder) continue;
    const dir = path.join(root, folder);
    await mkdir(dir, { recursive: true });

    const attachments = Array.isArray(req.attachments) ? req.attachments : [];
    for (const name of attachments) {
      const safe = path.basename(String(name || ''));
      if (!safe) continue;
      const buf = await downloadAttachment(String(req.id), safe);
      await writeFile(path.join(dir, safe), buf);
      console.log(`[dashbird]   ${folder}/${safe}`);
    }

    const requestJson = {
      id: req.id,
      folder: req.folder,
      title: req.title,
      body: req.body || '',
      platform: req.platform,
      area: req.area,
      areaLabel: req.areaLabel,
      section: req.section ?? null,
      priority: req.priority,
      priorityLabel: req.priorityLabel,
      status: req.status,
      attachments,
      createdAt: req.createdAt,
      updatedAt: req.updatedAt,
    };
    await writeFile(path.join(dir, 'request.json'), `${JSON.stringify(requestJson, null, 2)}\n`, 'utf8');
    console.log(`[dashbird]   ${folder}/request.json (${req.status})`);
  }

  await rebuildDevRequestsIndex();
  console.log('[dashbird] Rebuilt data/dev-requests/inbox.md');
  console.log('[dashbird] Done');
}

main().catch((e) => {
  console.error(`[dashbird] pull failed: ${e?.message || e}`);
  process.exit(1);
});
