#!/usr/bin/env node
/**
 * Pull dev requests from the cloud dashboard into local data/dev-requests/.
 *
 * Authenticates with the trusted-device gate (dashbird_did cookie for an
 * allowlisted device ID) — no basic-auth password needed. Device UUIDs are
 * non-secret (see .cursor/rules/trusted-devices.mdc); do not add other IDs.
 *
 * Usage:
 *   node scripts/pull-dev-requests.mjs
 *   DASHBIRD_CLOUD_ORIGIN=https://dashbird.duckdns.org \
 *   DASHBIRD_DEVICE_ID=edd37155-3ffe-4d18-a775-d6cdcedbf343 \
 *     node scripts/pull-dev-requests.mjs
 *
 * Refreshes open + done folders so local state mirrors the cloud queue, then
 * rebuilds the SQLite index and data/dev-requests/inbox.md for Cursor agents.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  devRequestsRoot,
  rebuildDevRequestsIndex,
} from '../src/lib/dev-requests-store.js';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ORIGIN = String(process.env.DASHBIRD_CLOUD_ORIGIN || 'https://dashbird.duckdns.org').replace(/\/+$/, '');
// Jay's home Linux laptop — one of the two allowlisted trusted devices.
const DEVICE_ID = String(process.env.DASHBIRD_DEVICE_ID || 'edd37155-3ffe-4d18-a775-d6cdcedbf343').trim();

async function apiGet(pathname) {
  const res = await fetch(`${ORIGIN}${pathname}`, {
    headers: { Cookie: `dashbird_did=${DEVICE_ID}` },
    redirect: 'manual',
  });
  if (res.status === 401 || res.status === 403 || res.status >= 300) {
    throw new Error(`GET ${pathname} → HTTP ${res.status} (trusted-device gate rejected ${DEVICE_ID})`);
  }
  return res.json();
}

async function pullStatus(status) {
  const list = await apiGet(`/api/dev-requests?status=${encodeURIComponent(status)}`);
  const requests = Array.isArray(list?.requests) ? list.requests : [];
  const root = devRequestsRoot();
  let pulled = 0;
  for (const summary of requests) {
    const detail = await apiGet(`/api/dev-requests/${encodeURIComponent(summary.id)}`);
    const req = detail?.request;
    if (!req?.id || !req?.folder) continue;
    const dir = path.join(root, req.folder);
    await mkdir(dir, { recursive: true });
    const { path: _serverPath, ...requestJson } = req;
    await writeFile(path.join(dir, 'request.json'), `${JSON.stringify(requestJson, null, 2)}\n`, 'utf8');
    for (const att of Array.isArray(req.attachments) ? req.attachments : []) {
      const name = path.basename(String(att));
      const fileRes = await fetch(`${ORIGIN}/api/dev-requests/${encodeURIComponent(req.id)}/files/${encodeURIComponent(name)}`, {
        headers: { Cookie: `dashbird_did=${DEVICE_ID}` },
        redirect: 'manual',
      });
      if (!fileRes.ok) {
        console.warn(`[dashbird] WARN: attachment ${name} for ${req.id} → HTTP ${fileRes.status}`);
        continue;
      }
      const buf = Buffer.from(await fileRes.arrayBuffer());
      await writeFile(path.join(dir, name), buf);
    }
    pulled += 1;
    console.log(`[dashbird] pulled ${status}: ${req.folder} — ${req.title}`);
  }
  return pulled;
}

const open = await pullStatus('open');
const done = await pullStatus('done');
await rebuildDevRequestsIndex();
const relInbox = path.relative(PKG_ROOT, path.join(devRequestsRoot(), 'inbox.md'));
console.log(`[dashbird] Done — ${open} open / ${done} done mirrored from ${ORIGIN}; inbox rebuilt at ${relInbox}`);
