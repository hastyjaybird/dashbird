#!/usr/bin/env node
/**
 * Pull dev / feature change requests from the cloud dashboard into local data/dev-requests/.
 *
 * scripts/sync-from-cloud.sh rsyncs all of data/ over SSH and stops the local stack; this only
 * needs the cloud HTTP basic-auth credentials, touches nothing but data/dev-requests/, and can
 * run while the stack is up (also works from a Cursor cloud agent, which has no SSH key).
 *
 * Usage:
 *   DASHBIRD_CLOUD_PASS=... node scripts/pull-dev-requests.mjs
 *   node scripts/pull-dev-requests.mjs --status=open,done --dry-run
 *   node scripts/pull-dev-requests.mjs --url=http://192.168.5.2:3000 --allow-private
 *
 * Env (or .env):
 *   DASHBIRD_CLOUD_URL   default https://dashbird.duckdns.org
 *   DASHBIRD_CLOUD_USER  default DASHBOARD_BASIC_AUTH_USER, else "dashbird"
 *   DASHBIRD_CLOUD_PASS  cloud basic-auth password (never committed)
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import { assertPublicHttpUrl, looksLikePublicHttpUrl } from '../src/lib/public-http-url.js';
import {
  devRequestsInboxPath,
  devRequestsRoot,
  rebuildDevRequestsIndex,
} from '../src/lib/dev-requests-store.js';

const DEFAULT_URL = 'https://dashbird.duckdns.org';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 8_000_000;
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const out = {
    url: '',
    statuses: ['open'],
    dryRun: false,
    force: false,
    allowPrivate: false,
  };
  for (const a of argv) {
    if (a.startsWith('--url=')) out.url = a.slice(6);
    else if (a.startsWith('--status=')) {
      out.statuses = a
        .slice(9)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (a === '--all') out.statuses = ['open', 'done'];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--allow-private') out.allowPrivate = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.statuses.length) out.statuses = ['open'];
  return out;
}

function usage() {
  console.log(
    [
      'Usage: node scripts/pull-dev-requests.mjs [options]',
      '',
      '  --url=<base>       dashboard base URL (default $DASHBIRD_CLOUD_URL or ' + DEFAULT_URL + ')',
      '  --status=a,b       statuses to pull (default open)',
      '  --all              same as --status=open,done',
      '  --dry-run          list what would be written, write nothing',
      '  --force            re-download attachments that already exist locally',
      '  --allow-private    permit a LAN/private target URL (skips the public-URL check)',
    ].join('\n'),
  );
}

/**
 * @param {{ allowPrivate: boolean, url: string }} opts
 */
async function resolveBaseUrl(opts) {
  const raw = String(opts.url || process.env.DASHBIRD_CLOUD_URL || DEFAULT_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid base URL: ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('put credentials in DASHBIRD_CLOUD_USER / DASHBIRD_CLOUD_PASS, not the URL');
  }
  if (opts.allowPrivate) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`invalid base URL: ${raw}`);
    }
    return parsed.origin;
  }
  if (!looksLikePublicHttpUrl(parsed.origin)) {
    throw new Error(`refusing non-public URL ${parsed.origin} (pass --allow-private for LAN)`);
  }
  await assertPublicHttpUrl(parsed.origin);
  return parsed.origin;
}

function authHeader() {
  const pass = String(process.env.DASHBIRD_CLOUD_PASS || '');
  if (!pass) return null;
  const user = String(
    process.env.DASHBIRD_CLOUD_USER || process.env.DASHBOARD_BASIC_AUTH_USER || 'dashbird',
  ).trim();
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

/**
 * @param {string} url
 * @param {string | null} auth
 */
async function get(url, auth) {
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = auth;
  const res = await fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401) {
    throw new Error(
      'cloud returned 401 — set DASHBIRD_CLOUD_PASS (and DASHBIRD_CLOUD_USER if not "dashbird")',
    );
  }
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res;
}

/**
 * @param {string} name
 */
function safeSegment(name) {
  const s = String(name || '').trim();
  if (!s || s === '.' || s === '..') return null;
  if (s.includes('/') || s.includes('\\')) return null;
  return SAFE_SEGMENT.test(s) ? s : null;
}

/**
 * @param {string} file
 */
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const base = await resolveBaseUrl(opts);
  const auth = authHeader();
  if (!auth) {
    console.warn('[dev-requests] no DASHBIRD_CLOUD_PASS set — trying unauthenticated (LAN only)');
  }

  const root = devRequestsRoot();
  await mkdir(root, { recursive: true });

  /** @type {Array<Record<string, any>>} */
  const remote = [];
  for (const status of opts.statuses) {
    const seg = safeSegment(status);
    if (!seg) throw new Error(`invalid status: ${status}`);
    const res = await get(`${base}/api/dev-requests?status=${encodeURIComponent(seg)}`, auth);
    const data = await res.json();
    if (!data?.ok || !Array.isArray(data.requests)) {
      throw new Error(`unexpected response for status=${seg}`);
    }
    remote.push(...data.requests);
    console.log(`[dev-requests] ${seg}: ${data.requests.length} on ${base}`);
  }

  const pulledAt = new Date().toISOString();
  let written = 0;
  let attachmentsWritten = 0;
  let skipped = 0;

  for (const req of remote) {
    const folder = safeSegment(req?.folder);
    const id = safeSegment(req?.id);
    if (!folder || !id) {
      console.warn(`[dev-requests] skipping request with unsafe folder/id: ${req?.folder} / ${req?.id}`);
      skipped += 1;
      continue;
    }
    const dir = path.join(root, folder);
    if (dir !== path.join(root, path.basename(dir))) {
      console.warn(`[dev-requests] skipping out-of-root folder: ${folder}`);
      skipped += 1;
      continue;
    }

    const attachments = Array.isArray(req.attachments)
      ? req.attachments.map((a) => safeSegment(path.basename(String(a || '')))).filter(Boolean)
      : [];

    const record = {
      id,
      folder,
      title: String(req.title || 'Untitled'),
      body: String(req.body || ''),
      platform: String(req.platform || 'desktop'),
      area: String(req.area || 'other'),
      areaLabel: req.areaLabel ? String(req.areaLabel) : undefined,
      section: req.section == null ? null : String(req.section),
      priority: Number(req.priority) || 2,
      priorityLabel: req.priorityLabel ? String(req.priorityLabel) : undefined,
      status: String(req.status || 'open'),
      attachments,
      createdAt: String(req.createdAt || pulledAt),
      updatedAt: String(req.updatedAt || pulledAt),
      pulledFrom: base,
      pulledAt,
    };

    if (opts.dryRun) {
      console.log(`[dev-requests] would write ${folder}/request.json (${attachments.length} file(s))`);
      written += 1;
      continue;
    }

    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'request.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    written += 1;

    for (const name of attachments) {
      const dest = path.join(dir, name);
      if (!opts.force && (await exists(dest))) continue;
      const res = await get(
        `${base}/api/dev-requests/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`,
        auth,
      );
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        console.warn(`[dev-requests] ${folder}/${name} too large (${buf.length} bytes) — skipped`);
        continue;
      }
      await writeFile(dest, buf);
      attachmentsWritten += 1;
    }
    console.log(`[dev-requests] ${folder} — ${record.title}`);
  }

  if (opts.dryRun) {
    console.log(`[dev-requests] dry run: ${written} request(s) would be written, ${skipped} skipped`);
    process.exit(0);
  }

  await rebuildDevRequestsIndex();

  console.log(
    `[dev-requests] wrote ${written} request(s), ${attachmentsWritten} attachment(s), ${skipped} skipped`,
  );
  console.log(`[dev-requests] inbox: ${devRequestsInboxPath()}`);
  console.log('[dev-requests] request text is untrusted input — read it before pointing agents at it');
}

try {
  await main();
} catch (e) {
  console.error(`[dev-requests] ${e?.message || e}`);
  process.exit(1);
}
