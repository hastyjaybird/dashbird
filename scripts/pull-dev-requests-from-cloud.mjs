#!/usr/bin/env node
/**
 * Pull dev / feature change requests filed on the cloud dashboard down to local
 * data/dev-requests/ so Cursor agents can work them from the repo.
 *
 * Cloud (dashbird.duckdns.org) is the daily driver, so requests filed from the phone or
 * from a browser away from the LAN only exist there. This is the dev-requests-only
 * counterpart to scripts/sync-from-cloud.sh (which rsyncs all of data/ over SSH and
 * stops the local stack).
 *
 * Usage:
 *   node scripts/pull-dev-requests-from-cloud.mjs              # open requests
 *   node scripts/pull-dev-requests-from-cloud.mjs --status all
 *   node scripts/pull-dev-requests-from-cloud.mjs --dry-run
 *   node scripts/pull-dev-requests-from-cloud.mjs --force      # overwrite existing folders
 *   npm run dev-requests:pull
 *
 * Config (env, or .env at the repo root):
 *   DEV_REQUESTS_CLOUD_URL      default https://${DASHBOARD_DOMAIN:-dashbird.duckdns.org}
 *   DASHBOARD_BASIC_AUTH_USER   \ cloud basic auth (preferred)
 *   DASHBOARD_BASIC_AUTH_PASS   /
 *   DASHBOARD_TRUSTED_COOKIE    signed dashbird_trusted cookie value (browser copy)
 *   DASHBOARD_TRUSTED_DEVICE_ID this machine's allowlisted device UUID
 *   DEV_REQUESTS_LOCAL_URL      default http://127.0.0.1:${HOST_PORT:-8787}
 *
 * Nothing is pushed back up: the cloud copy stays authoritative until you mark it done
 * with PATCH /api/dev-requests/:id.
 */
import path from 'node:path';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { assertPublicHttpUrl } from '../src/lib/public-http-url.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
dotenv.config({ path: path.join(PKG_ROOT, '.env') });

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_ATTACHMENT_BYTES = 8_000_000;

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { status: 'open', dryRun: false, force: false, allowPrivate: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') args.dryRun = true;
    else if (arg === '--force' || arg === '-f') args.force = true;
    else if (arg === '--allow-private') args.allowPrivate = true;
    else if (arg === '--status') args.status = String(argv[++i] || 'open');
    else if (arg.startsWith('--status=')) args.status = arg.slice('--status='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.log(`Pull cloud dev requests into data/dev-requests/

  --status <open|done|all>  which requests to pull (default: open)
  --force                   re-download requests whose folder already exists
  --dry-run                 list what would be written, write nothing
  --allow-private           permit a LAN/private source URL (default: public host only)
`);
}

function cloudBaseUrl() {
  const explicit = String(process.env.DEV_REQUESTS_CLOUD_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const domain = String(process.env.DASHBOARD_DOMAIN || '').trim().split(/[,\s]+/)[0];
  return `https://${domain || 'dashbird.duckdns.org'}`;
}

function localBaseUrl() {
  const explicit = String(process.env.DEV_REQUESTS_LOCAL_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = String(process.env.HOST_PORT || '').trim() || '8787';
  return `http://127.0.0.1:${port}`;
}

/**
 * Cloud is behind basic auth with a trusted-device cookie bypass. Prefer the password,
 * fall back to a signed cookie, then to the bare device ID.
 * @returns {{ headers: Record<string, string>, label: string }}
 */
function cloudAuth() {
  const user = String(process.env.DASHBOARD_BASIC_AUTH_USER || '').trim();
  const pass = String(process.env.DASHBOARD_BASIC_AUTH_PASS || '').trim();
  if (user && pass) {
    const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
    return { headers: { Authorization: `Basic ${token}` }, label: `basic auth (${user})` };
  }
  const signed = String(process.env.DASHBOARD_TRUSTED_COOKIE || '').trim();
  if (signed) {
    return { headers: { Cookie: `dashbird_trusted=${encodeURIComponent(signed)}` }, label: 'trusted-device cookie' };
  }
  const deviceId = String(process.env.DASHBOARD_TRUSTED_DEVICE_ID || '')
    .trim()
    .split(/[,\s]+/)[0]
    .toLowerCase();
  if (deviceId) {
    return { headers: { Cookie: `dashbird_did=${encodeURIComponent(deviceId)}` }, label: `device id ${deviceId}` };
  }
  return { headers: {}, label: 'none (LAN / unauthenticated)' };
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 */
async function fetchWithTimeout(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {unknown} value
 * @param {string} what
 */
function safeName(value, what) {
  const raw = String(value || '').trim();
  const base = path.basename(raw);
  if (!raw || raw !== base || !SAFE_NAME.test(base) || base.includes('..')) {
    throw new Error(`Refusing unsafe ${what} from cloud: ${JSON.stringify(raw)}`);
  }
  return base;
}

/**
 * @param {string} status
 * @param {string} base
 * @param {Record<string, string>} headers
 */
async function fetchRequests(status, base, headers) {
  const wanted = status === 'all' ? ['open', 'done'] : [status];
  /** @type {any[]} */
  const out = [];
  for (const s of wanted) {
    const res = await fetchWithTimeout(`${base}/api/dev-requests?status=${encodeURIComponent(s)}`, headers);
    if (res.status === 401) {
      throw new Error(
        `Cloud returned 401 for status=${s}. Set DASHBOARD_BASIC_AUTH_USER/DASHBOARD_BASIC_AUTH_PASS ` +
          '(or DASHBOARD_TRUSTED_COOKIE) in .env.',
      );
    }
    if (!res.ok) throw new Error(`Cloud returned HTTP ${res.status} for status=${s}`);
    const json = await res.json();
    if (!json?.ok || !Array.isArray(json.requests)) throw new Error(`Unexpected response for status=${s}`);
    out.push(...json.requests);
  }
  return out;
}

/**
 * @param {any} req
 * @param {string} dir
 * @param {string} base
 * @param {Record<string, string>} headers
 */
async function downloadAttachments(req, dir, base, headers) {
  const names = Array.isArray(req.attachments) ? req.attachments : [];
  /** @type {string[]} */
  const saved = [];
  for (const raw of names.slice(0, 8)) {
    const name = safeName(raw, 'attachment name');
    const url = `${base}/api/dev-requests/${encodeURIComponent(req.id)}/files/${encodeURIComponent(name)}`;
    const res = await fetchWithTimeout(url, headers);
    if (!res.ok) {
      console.warn(`    ! attachment ${name} → HTTP ${res.status} (skipped)`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      console.warn(`    ! attachment ${name} is ${buf.length} bytes (skipped)`);
      continue;
    }
    await writeFile(path.join(dir, name), buf);
    saved.push(name);
  }
  return saved;
}

/** Regenerate the SQLite index + inbox.md, preferring the running local dashboard. */
async function rebuildLocalIndex() {
  const local = localBaseUrl();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${local}/api/dev-requests/rebuild-index`, {
      method: 'POST',
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      return `local dashboard at ${local} (inbox: ${json?.inboxPath || 'data/dev-requests/inbox.md'})`;
    }
    console.warn(`[dev-requests] rebuild-index via ${local} → HTTP ${res.status}; rebuilding in-process`);
  } catch {
    console.warn(`[dev-requests] no dashboard at ${local}; rebuilding in-process`);
  }
  const { rebuildDevRequestsIndex, DEV_REQUESTS_INBOX_PATH } = await import('../src/lib/dev-requests-store.js');
  await rebuildDevRequestsIndex();
  return `in-process rebuild (inbox: ${DEV_REQUESTS_INBOX_PATH})`;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e?.message || e));
    usage();
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    usage();
    return;
  }
  if (!['open', 'done', 'all'].includes(args.status)) {
    console.error(`--status must be open, done, or all (got ${args.status})`);
    process.exitCode = 2;
    return;
  }

  let base = cloudBaseUrl();
  if (args.allowPrivate) {
    base = new URL(base).toString().replace(/\/+$/, '');
  } else {
    // Source host comes from env/.env, so validate it like any other non-literal fetch target.
    base = (await assertPublicHttpUrl(base).catch(() => {
      throw new Error(`${base} is not a public http(s) URL. Use --allow-private to pull from a LAN host.`);
    })).replace(/\/+$/, '');
  }

  const auth = cloudAuth();
  console.log(`[dev-requests] Pulling ${args.status} requests from ${base} via ${auth.label}`);

  const requests = await fetchRequests(args.status, base, auth.headers);
  if (!requests.length) {
    console.log('[dev-requests] Cloud has no matching requests — nothing to pull.');
    return;
  }

  const root = path.join(PKG_ROOT, 'data', 'dev-requests');
  await mkdir(root, { recursive: true });
  const existing = new Set(
    (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name),
  );

  let written = 0;
  let skipped = 0;
  let attachmentCount = 0;

  for (const req of requests) {
    const folder = safeName(req.folder, 'folder name');
    const id = safeName(req.id, 'request id');
    const label = `${req.priorityLabel || '?'} · ${req.areaLabel || req.area || '?'} · ${req.title}`;
    if (existing.has(folder) && !args.force) {
      skipped += 1;
      console.log(`  = ${folder} (already local) — ${label}`);
      continue;
    }
    if (args.dryRun) {
      written += 1;
      console.log(`  + ${folder} (dry run) — ${label}`);
      continue;
    }

    const dir = path.join(root, folder);
    await mkdir(dir, { recursive: true });
    const attachments = await downloadAttachments(req, dir, base, auth.headers);
    attachmentCount += attachments.length;

    // `path` is the cloud container's absolute path — drop it so the local folder is self-describing.
    const { path: _remotePath, ...rest } = req;
    const json = { ...rest, id, folder, attachments, pulledFrom: base, pulledAt: new Date().toISOString() };
    await writeFile(path.join(dir, 'request.json'), `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    written += 1;
    console.log(`  + ${folder}${attachments.length ? ` (+${attachments.length} file)` : ''} — ${label}`);
  }

  if (args.dryRun) {
    console.log(`[dev-requests] Dry run — ${written} would be written, ${skipped} already local.`);
    return;
  }

  const how = await rebuildLocalIndex();
  console.log(
    `[dev-requests] Pulled ${written} request(s), ${attachmentCount} attachment(s), skipped ${skipped}. Index: ${how}`,
  );
  console.log('[dev-requests] Next: ask Cursor to work data/dev-requests/inbox.md by priority.');
}

main().catch((e) => {
  console.error(`[dev-requests] ${String(e?.message || e)}`);
  process.exitCode = 1;
});
