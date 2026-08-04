#!/usr/bin/env node
/**
 * Pull dev-requests from the live cloud dashboard into data/dev-requests/.
 * Uses HTTPS + basic auth (no SSH). For rsync/SSH, use pull-dev-requests-from-cloud.sh.
 *
 * Env (from .env or Cursor environment secrets):
 *   DASHBOARD_CLOUD_URL   default https://dashbird.duckdns.org
 *   DASHBOARD_BASIC_AUTH_USER
 *   DASHBOARD_BASIC_AUTH_PASS
 */
import 'dotenv/config';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildDevRequestsIndex } from '../src/lib/dev-requests-store.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = String(process.env.DASHBOARD_CLOUD_URL || 'https://dashbird.duckdns.org').replace(/\/$/, '');
const USER = String(process.env.DASHBOARD_BASIC_AUTH_USER || '').trim();
const PASS = String(process.env.DASHBOARD_BASIC_AUTH_PASS || '').trim();

if (!USER || !PASS) {
  console.error(
    '[dashbird] Set DASHBOARD_BASIC_AUTH_USER and DASHBOARD_BASIC_AUTH_PASS in .env or Cursor environment secrets.',
  );
  process.exit(1);
}

const authHeader = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

/** @param {string} urlPath */
async function cloudFetch(urlPath) {
  const url = `${BASE}${urlPath}`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
    redirect: 'follow',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${url} → HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res;
}

async function main() {
  console.log(`[dashbird] Pulling dev-requests from ${BASE}`);

  const listRes = await cloudFetch('/api/dev-requests?status=open');
  const listJson = await listRes.json();
  const requests = Array.isArray(listJson?.requests) ? listJson.requests : [];
  console.log(`[dashbird] Found ${requests.length} open request(s)`);

  const root = path.join(ROOT, 'data', 'dev-requests');
  await mkdir(root, { recursive: true });

  for (const req of requests) {
    const detailRes = await cloudFetch(`/api/dev-requests/${encodeURIComponent(req.id)}`);
    const detailJson = await detailRes.json();
    const full = detailJson?.request || req;
    const folder = String(full.folder || req.folder || '').trim();
    if (!folder) {
      console.warn(`[dashbird] Skipping request ${req.id} — no folder name`);
      continue;
    }

    const dir = path.join(root, folder);
    await mkdir(dir, { recursive: true });

    const attachments = Array.isArray(full.attachments) ? full.attachments : [];
    for (const name of attachments) {
      const safe = path.basename(String(name || ''));
      if (!safe) continue;
      const fileRes = await cloudFetch(
        `/api/dev-requests/${encodeURIComponent(full.id)}/files/${encodeURIComponent(safe)}`,
      );
      const buf = Buffer.from(await fileRes.arrayBuffer());
      await writeFile(path.join(dir, safe), buf);
      console.log(`  ${folder}/${safe}`);
    }

    const requestJson = {
      id: full.id,
      folder,
      title: full.title,
      body: full.body || '',
      platform: full.platform,
      area: full.area,
      areaLabel: full.areaLabel,
      section: full.section ?? null,
      priority: full.priority,
      priorityLabel: full.priorityLabel,
      status: full.status,
      attachments,
      createdAt: full.createdAt,
      updatedAt: full.updatedAt,
    };
    await writeFile(path.join(dir, 'request.json'), `${JSON.stringify(requestJson, null, 2)}\n`, 'utf8');
    console.log(`[dashbird] Wrote ${folder}/request.json — ${full.title}`);
  }

  const inboxPath = await rebuildDevRequestsIndex();
  const inbox = await readFile(inboxPath, 'utf8');
  console.log(`[dashbird] Regenerated ${path.relative(ROOT, inboxPath)}`);
  if (requests.length === 0) {
    console.log('[dashbird] No open dev requests on cloud.');
  } else {
    console.log('\n--- inbox preview ---\n');
    console.log(inbox.split('\n').slice(0, 40).join('\n'));
  }
}

main().catch((e) => {
  console.error(`[dashbird] Pull failed: ${e?.message || e}`);
  process.exit(1);
});
