#!/usr/bin/env node
/**
 * Pull dev requests (request.json + screenshots) from the cloud dashboard into the local
 * data/dev-requests/ tree, then rebuild the local index + inbox.md so Cursor agents can work
 * the queue. Unlike scripts/sync-from-cloud.sh this needs no SSH and touches nothing else
 * under data/ — it only adds/updates dev-request folders.
 *
 * Usage:
 *   node scripts/pull-dev-requests-from-cloud.mjs                 # open requests
 *   node scripts/pull-dev-requests-from-cloud.mjs --status=all    # open + done
 *   node scripts/pull-dev-requests-from-cloud.mjs --dry-run
 *   node scripts/pull-dev-requests-from-cloud.mjs --url=https://dashbird.example.com
 *
 * Auth (cloud is gated, LAN is open) — set one of:
 *   DASHBIRD_CLOUD_USER + DASHBIRD_CLOUD_PASS   basic-auth credentials
 *   DASHBIRD_CLOUD_DEVICE_ID                    allowlisted trusted-device UUID
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import { assertPublicHttpUrl } from '../src/lib/public-http-url.js';
import { devRequestsRoot, rebuildDevRequestsIndex } from '../src/lib/dev-requests-store.js';

const DEFAULT_CLOUD_URL = 'https://dashbird.jayhasty.com';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 8_000_000;
const ATTACHMENT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
// Folder / file names come off the wire, so they are only ever used as a single path segment.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/**
 * @param {string[]} argv
 * @param {string} name
 * @param {string} [fallback]
 */
function flag(argv, name, fallback = '') {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : fallback;
}

/** @param {string} raw */
export function parseStatuses(raw) {
  const value = String(raw || 'open').toLowerCase();
  if (value === 'all') return ['open', 'done'];
  return [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
}

/** @param {string[]} argv */
function cloudBaseUrl(argv) {
  const explicit = flag(argv, 'url') || String(process.env.DASHBIRD_CLOUD_URL || '').trim();
  if (explicit) return explicit;
  const domain = String(process.env.DASHBOARD_DOMAIN || '').trim();
  if (domain) return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  return DEFAULT_CLOUD_URL;
}

function firstTrustedDeviceId() {
  return (
    String(process.env.DASHBOARD_TRUSTED_DEVICE_IDS || '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)[0] || ''
  );
}

/** @param {string} accept */
function authHeaders(accept) {
  /** @type {Record<string, string>} */
  const headers = { Accept: accept };
  const user = String(process.env.DASHBIRD_CLOUD_USER || process.env.DASHBOARD_BASIC_AUTH_USER || '').trim();
  const pass = String(process.env.DASHBIRD_CLOUD_PASS || '');
  if (user && pass) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  const deviceId = String(process.env.DASHBIRD_CLOUD_DEVICE_ID || firstTrustedDeviceId()).trim().toLowerCase();
  if (deviceId) headers.Cookie = `dashbird_did=${encodeURIComponent(deviceId)}`;
  return headers;
}

function hasAnyCredential() {
  const basic = process.env.DASHBIRD_CLOUD_USER && process.env.DASHBIRD_CLOUD_PASS;
  return Boolean(basic || process.env.DASHBIRD_CLOUD_DEVICE_ID || firstTrustedDeviceId());
}

/**
 * Reject anything that is not already a clean single path segment rather than reducing it —
 * a rewritten name would land in a folder the cloud never had.
 * @param {unknown} name
 */
export function safeSegment(name) {
  const raw = String(name || '').trim();
  if (!raw || raw === '.' || raw === '..') return '';
  if (raw !== path.basename(raw)) return '';
  return SAFE_SEGMENT.test(raw) ? raw : '';
}

/**
 * Strip the remote container path and keep the on-disk shape createDevRequest writes.
 * @param {Record<string, unknown>} remote
 * @param {string[]} attachments
 */
export function toRequestJson(remote, attachments) {
  const { path: _remotePath, ...rest } = remote;
  return { ...rest, attachments };
}

/**
 * @param {URL} url
 * @param {string} accept
 */
async function cloudFetch(url, accept) {
  const res = await fetch(url, {
    headers: authHeaders(accept),
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${res.status} from ${url.pathname} — set DASHBIRD_CLOUD_USER + DASHBIRD_CLOUD_PASS, or DASHBIRD_CLOUD_DEVICE_ID to an allowlisted device UUID.`,
    );
  }
  if (!res.ok) throw new Error(`${res.status} from ${url.pathname}`);
  return res;
}

/**
 * @param {string} base
 * @param {string} status
 */
async function fetchRequests(base, status) {
  const url = new URL('/api/dev-requests', base);
  url.searchParams.set('status', status);
  const res = await cloudFetch(url, 'application/json');
  const body = await res.json();
  if (!body?.ok || !Array.isArray(body.requests)) {
    throw new Error(`unexpected response for status=${status}`);
  }
  return body.requests;
}

/**
 * @param {string} base
 * @param {string} id
 * @param {string} filename
 * @param {string} destPath
 */
async function downloadAttachment(base, id, filename, destPath) {
  const url = new URL(`/api/dev-requests/${encodeURIComponent(id)}/files/${encodeURIComponent(filename)}`, base);
  const res = await cloudFetch(url, 'image/*');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment ${filename} has an unusable size (${buf.length} bytes)`);
  }
  await writeFile(destPath, buf);
}

/**
 * @param {string} base already-validated origin
 * @param {string[]} statuses
 * @param {{ root?: string, dryRun?: boolean, log?: (msg: string) => void }} [opts]
 */
export async function pullDevRequests(base, statuses, opts = {}) {
  const root = opts.root || devRequestsRoot();
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log || ((msg) => console.log(msg));

  /** @type {string[]} */
  const folders = [];
  let skipped = 0;
  let attachments = 0;

  for (const status of statuses) {
    const requests = await fetchRequests(base, status);
    log(`[dashbird] ${status}: ${requests.length} request(s)`);

    for (const remote of requests) {
      const folder = safeSegment(remote?.folder);
      const id = safeSegment(remote?.id);
      if (!folder || !id) {
        skipped += 1;
        log(`  ! skipped a request with an unusable id/folder (${String(remote?.folder)})`);
        continue;
      }

      const title = String(remote?.title || 'Untitled');
      if (dryRun) {
        folders.push(folder);
        log(`  · would write ${folder}/ — ${title}`);
        continue;
      }

      const dir = path.join(root, folder);
      await mkdir(dir, { recursive: true });

      /** @type {string[]} */
      const saved = [];
      const remoteAttachments = Array.isArray(remote?.attachments) ? remote.attachments : [];
      for (const raw of remoteAttachments) {
        const filename = safeSegment(raw);
        if (!filename || !ATTACHMENT_EXTS.has(path.extname(filename).toLowerCase())) {
          log(`  ! ${folder}: skipped attachment with an unusable name (${String(raw)})`);
          continue;
        }
        try {
          await downloadAttachment(base, id, filename, path.join(dir, filename));
          saved.push(filename);
          attachments += 1;
        } catch (e) {
          log(`  ! ${folder}: attachment ${filename} failed — ${String(e?.message || e)}`);
        }
      }

      await writeFile(
        path.join(dir, 'request.json'),
        `${JSON.stringify(toRequestJson(remote, saved), null, 2)}\n`,
        'utf8',
      );
      folders.push(folder);
      log(`  ✓ ${folder} — ${title}`);
    }
  }

  return { folders, attachments, skipped };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const statuses = parseStatuses(flag(argv, 'status', 'open'));
  if (!statuses.length) {
    console.error('Nothing to pull: --status must be open, done, a comma list, or all.');
    process.exit(1);
  }

  const base = await assertPublicHttpUrl(cloudBaseUrl(argv));
  if (!hasAnyCredential()) {
    console.warn('[dashbird] No cloud credential configured — the request will likely be rejected with 401.');
  }
  console.log(`[dashbird] Pulling dev requests (${statuses.join(', ')}) from ${base}`);

  const { folders, attachments } = await pullDevRequests(base, statuses, { dryRun });

  if (dryRun) {
    console.log('[dashbird] Dry run — nothing written, index not rebuilt.');
    return;
  }

  try {
    await rebuildDevRequestsIndex();
    console.log(
      `[dashbird] Rebuilt local index + inbox.md (${folders.length} request(s), ${attachments} screenshot(s))`,
    );
  } catch (e) {
    // data/dev-requests.db is usually created by the container (root-owned on the LAN host).
    console.warn(`[dashbird] Folders written, but the local index rebuild failed — ${String(e?.message || e)}`);
    console.warn('[dashbird] Rebuild from the running stack instead:');
    console.warn('[dashbird]   curl -X POST http://localhost:${HOST_PORT:-8787}/api/dev-requests/rebuild-index');
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(`[dashbird] Pull failed: ${String(e?.message || e)}`);
    process.exit(1);
  });
}
