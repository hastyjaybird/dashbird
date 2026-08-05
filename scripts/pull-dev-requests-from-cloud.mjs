#!/usr/bin/env node
/**
 * Pull dev / feature change requests from the Dashbird cloud into local data/dev-requests/.
 *
 * Requests filed from the phone land on the cloud box, so a local checkout starts empty.
 * This mirrors each cloud request into its own folder (request.json + screenshots) and
 * rebuilds the local SQLite index + inbox.md so Cursor agents can work the queue.
 *
 * Usage:
 *   node scripts/pull-dev-requests-from-cloud.mjs                  # open requests
 *   node scripts/pull-dev-requests-from-cloud.mjs --status all     # open + done + closed + archived
 *   node scripts/pull-dev-requests-from-cloud.mjs --dry-run
 *   node scripts/pull-dev-requests-from-cloud.mjs --force          # re-download unchanged folders
 *   node scripts/pull-dev-requests-from-cloud.mjs --no-index       # skip local SQLite/inbox rebuild
 *
 * Config (env or .env):
 *   DASHBIRD_CLOUD_ORIGIN     https origin, default https://dashbird.jayhasty.com
 *   DASHBIRD_CLOUD_USER       basic-auth user (DASHBOARD_BASIC_AUTH_USER on the server)
 *   DASHBIRD_CLOUD_PASS       basic-auth password
 *   DASHBIRD_CLOUD_DEVICE_ID  allowlisted trusted-device UUID, used when no password is set
 *
 * Pull only reads the cloud and never deletes local folders, so local-only requests survive.
 * Stop the local stack first if you want the rebuilt index to be picked up cleanly, or run
 * `curl -X POST http://localhost:8787/api/dev-requests/rebuild-index` afterwards.
 */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { assertPublicHttpUrl } from '../src/lib/public-http-url.js';
import { devRequestsRoot, rebuildDevRequestsIndex } from '../src/lib/dev-requests-store.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFAULT_ORIGIN = 'https://dashbird.jayhasty.com';
const ALL_STATUSES = ['open', 'done', 'closed', 'archived'];
const ATTACHMENT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_ATTACHMENT_BYTES = 8_000_000;

/** @param {string} value */
function safeFolderName(value) {
  const name = String(value || '').trim();
  if (!name || name !== path.basename(name) || name === '.' || name === '..') return '';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return '';
  return name;
}

/** @param {string} value */
function safeAttachmentName(value) {
  const name = path.basename(String(value || '').trim());
  if (!name || name.startsWith('.')) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return '';
  if (!ATTACHMENT_EXTS.has(path.extname(name).toLowerCase())) return '';
  return name;
}

/**
 * Strip server-side fields and keep the on-disk shape the store writes.
 * @param {Record<string, any>} req
 * @param {string[]} attachments
 */
function toRequestJson(req, attachments) {
  return {
    id: String(req.id),
    folder: String(req.folder),
    title: String(req.title || 'Untitled'),
    body: String(req.body || ''),
    platform: String(req.platform || 'desktop'),
    area: String(req.area || 'other'),
    areaLabel: String(req.areaLabel || ''),
    section: req.section ? String(req.section) : null,
    priority: Number(req.priority) || 2,
    priorityLabel: String(req.priorityLabel || 'Med'),
    status: String(req.status || 'open'),
    attachments,
    createdAt: String(req.createdAt || new Date().toISOString()),
    updatedAt: String(req.updatedAt || req.createdAt || new Date().toISOString()),
  };
}

/**
 * @param {{ user?: string, pass?: string, deviceId?: string }} auth
 */
function buildAuthHeaders(auth) {
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' };
  if (auth.user && auth.pass) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`;
  }
  if (auth.deviceId) {
    headers.Cookie = `dashbird_did=${encodeURIComponent(auth.deviceId)}`;
  }
  return headers;
}

/**
 * Mirror cloud dev requests onto disk.
 *
 * @param {{
 *   origin?: string,
 *   statuses?: string[],
 *   auth?: { user?: string, pass?: string, deviceId?: string },
 *   outRoot?: string,
 *   dryRun?: boolean,
 *   force?: boolean,
 *   fetchImpl?: typeof fetch,
 *   requirePublicOrigin?: boolean,
 *   log?: (msg: string) => void,
 * }} [options]
 */
export async function pullDevRequests(options = {}) {
  const {
    origin = DEFAULT_ORIGIN,
    statuses = ['open'],
    auth = {},
    outRoot = devRequestsRoot(),
    dryRun = false,
    force = false,
    fetchImpl = fetch,
    // Only the smoke test flips this off, to run against a loopback stub server.
    requirePublicOrigin = true,
    log = (msg) => console.log(msg),
  } = options;

  const base = requirePublicOrigin
    ? new URL(await assertPublicHttpUrl(origin))
    : new URL(String(origin));
  const headers = buildAuthHeaders(auth);

  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  for (const status of statuses) {
    const url = new URL('/api/dev-requests', base);
    url.searchParams.set('status', status);
    const res = await fetchImpl(url, { headers, redirect: 'error' });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `cloud rejected the request (${res.status}) — set DASHBIRD_CLOUD_USER/DASHBIRD_CLOUD_PASS or DASHBIRD_CLOUD_DEVICE_ID`,
      );
    }
    if (!res.ok) throw new Error(`GET ${url.pathname}?status=${status} failed: ${res.status}`);
    const body = await res.json();
    if (!body?.ok || !Array.isArray(body.requests)) {
      throw new Error(`unexpected response for status=${status}`);
    }
    for (const req of body.requests) {
      if (req?.id) byId.set(String(req.id), req);
    }
  }

  const summary = { fetched: byId.size, written: 0, skipped: 0, attachments: 0, folders: [] };
  await mkdir(outRoot, { recursive: true });

  for (const req of byId.values()) {
    const folder = safeFolderName(req.folder);
    if (!folder) {
      log(`  skip ${req.id}: unsafe folder name`);
      summary.skipped += 1;
      continue;
    }
    const dir = path.join(outRoot, folder);
    const jsonPath = path.join(dir, 'request.json');

    if (!force) {
      const localUpdatedAt = await readLocalUpdatedAt(jsonPath);
      if (localUpdatedAt && localUpdatedAt >= String(req.updatedAt || '')) {
        summary.skipped += 1;
        continue;
      }
    }

    const wanted = (Array.isArray(req.attachments) ? req.attachments : [])
      .map(safeAttachmentName)
      .filter(Boolean);

    if (dryRun) {
      log(`  would write ${folder}/ (${wanted.length} attachment(s))`);
      summary.written += 1;
      summary.folders.push(folder);
      continue;
    }

    await mkdir(dir, { recursive: true });
    /** @type {string[]} */
    const saved = [];
    for (const name of wanted) {
      const fileUrl = new URL(
        `/api/dev-requests/${encodeURIComponent(String(req.id))}/files/${encodeURIComponent(name)}`,
        base,
      );
      const res = await fetchImpl(fileUrl, { headers, redirect: 'error' });
      if (!res.ok) {
        log(`  warn ${folder}: attachment ${name} unavailable (${res.status})`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_ATTACHMENT_BYTES) {
        log(`  warn ${folder}: attachment ${name} rejected (${buf.length} bytes)`);
        continue;
      }
      await writeFile(path.join(dir, name), buf);
      saved.push(name);
      summary.attachments += 1;
    }

    const json = toRequestJson(req, saved);
    await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    summary.written += 1;
    summary.folders.push(folder);
    log(`  ${folder}/ — ${json.status} · ${json.priorityLabel} · ${json.title}`);
  }

  return summary;
}

/** @param {string} jsonPath */
async function readLocalUpdatedAt(jsonPath) {
  try {
    const parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
    return String(parsed?.updatedAt || '');
  } catch {
    return '';
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { statuses: ['open'], dryRun: false, force: false, index: true, origin: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--dry-run' || arg === '-n') args.dryRun = true;
    else if (arg === '--force' || arg === '-f') args.force = true;
    else if (arg === '--no-index') args.index = false;
    else if (arg === '--origin') args.origin = next();
    else if (arg.startsWith('--origin=')) args.origin = arg.slice(9);
    else if (arg === '--status' || arg.startsWith('--status=')) {
      const raw = arg.startsWith('--status=') ? arg.slice(9) : next();
      args.statuses = raw === 'all' ? [...ALL_STATUSES] : raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.statuses.length) args.statuses = ['open'];
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        'Usage: node scripts/pull-dev-requests-from-cloud.mjs [options]',
        '  --status open|done|all|a,b   statuses to pull (default: open)',
        '  --origin <url>               cloud origin (default: $DASHBIRD_CLOUD_ORIGIN or ' + DEFAULT_ORIGIN + ')',
        '  --dry-run, -n                list what would be written',
        '  --force, -f                  rewrite folders even when unchanged',
        '  --no-index                   skip local SQLite + inbox.md rebuild',
      ].join('\n'),
    );
    return;
  }

  const origin = args.origin || process.env.DASHBIRD_CLOUD_ORIGIN || DEFAULT_ORIGIN;
  const auth = {
    user: String(process.env.DASHBIRD_CLOUD_USER || '').trim(),
    pass: String(process.env.DASHBIRD_CLOUD_PASS || ''),
    deviceId: String(process.env.DASHBIRD_CLOUD_DEVICE_ID || '').trim(),
  };
  const mode = auth.user && auth.pass ? 'basic auth' : auth.deviceId ? 'trusted device id' : 'none';
  console.log(`[dashbird] Pulling dev requests from ${origin} (auth: ${mode}, status: ${args.statuses.join(',')})`);

  const summary = await pullDevRequests({
    origin,
    statuses: args.statuses,
    auth,
    dryRun: args.dryRun,
    force: args.force,
  });

  if (args.index && !args.dryRun && summary.written) {
    await rebuildDevRequestsIndex();
    console.log('[dashbird] Rebuilt data/dev-requests.db + inbox.md');
  }

  const rel = path.relative(PKG_ROOT, devRequestsRoot()) || 'data/dev-requests';
  console.log(
    `[dashbird] ${summary.fetched} fetched · ${summary.written} written · ${summary.skipped} unchanged · ${summary.attachments} screenshot(s) → ${rel}/`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`[dashbird] ${e?.message || e}`);
    process.exit(1);
  });
}
