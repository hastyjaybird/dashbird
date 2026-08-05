#!/usr/bin/env node
/**
 * Smoke: scripts/pull-dev-requests-from-cloud.mjs mirrors a cloud dev-requests API
 * into local folders, downloads screenshots, refuses unsafe names, skips unchanged
 * folders, and rebuilds the SQLite index + inbox.md. Runs against a loopback stub.
 */
import http from 'node:http';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pullDevRequests } from './pull-dev-requests-from-cloud.mjs';
import { listDevRequests, rebuildDevRequestsIndex } from '../src/lib/dev-requests-store.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const CLOUD = {
  open: [
    {
      id: 'aa11bb22',
      folder: '20260805-064031-med-events-desktop-aa11bb22',
      title: 'Replace sleep icon with zzz',
      body: 'Use the zzz glyph, not the sleeping face.',
      platform: 'desktop',
      area: 'events',
      areaLabel: 'Events',
      section: null,
      priority: 2,
      priorityLabel: 'Med',
      status: 'open',
      attachments: ['screenshot.png', '../../escape.png', 'notes.txt'],
      createdAt: '2026-08-05T06:40:31.563Z',
      updatedAt: '2026-08-05T06:40:31.563Z',
      path: '/app/data/dev-requests/20260805-064031-med-events-desktop-aa11bb22',
    },
    {
      id: 'cc33dd44',
      folder: '../../../etc/passwd',
      title: 'Malicious folder name',
      body: '',
      platform: 'mobile',
      area: 'notes',
      priority: 1,
      status: 'open',
      attachments: [],
      createdAt: '2026-08-05T06:41:00.000Z',
      updatedAt: '2026-08-05T06:41:00.000Z',
    },
  ],
  done: [
    {
      id: 'ee55ff66',
      folder: '20260730-021234-med-events-desktop-ee55ff66',
      title: 'Already shipped',
      body: '',
      platform: 'desktop',
      area: 'events',
      areaLabel: 'Events',
      priority: 2,
      priorityLabel: 'Med',
      status: 'done',
      attachments: [],
      createdAt: '2026-07-30T02:12:34.458Z',
      updatedAt: '2026-08-04T21:19:53.789Z',
    },
  ],
};

let failed = 0;
/**
 * @param {boolean} cond
 * @param {string} label
 * @param {unknown} [detail]
 */
function check(cond, label, detail) {
  if (cond) {
    console.log(`ok ${label}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${label}`, detail ?? '');
}

const requestLog = [];
const server = http.createServer((req, res) => {
  requestLog.push({ url: req.url, auth: req.headers.authorization || '', cookie: req.headers.cookie || '' });
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/dev-requests') {
    const status = url.searchParams.get('status') || 'open';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, requests: CLOUD[status] || [], inboxPath: '/app/data/dev-requests/inbox.md' }));
    return;
  }
  const file = url.pathname.match(/^\/api\/dev-requests\/([^/]+)\/files\/([^/]+)$/);
  if (file) {
    if (decodeURIComponent(file[2]) !== 'screenshot.png') {
      res.statusCode = 404;
      res.end('{"ok":false}');
      return;
    }
    res.setHeader('content-type', 'image/png');
    res.end(PNG);
    return;
  }
  res.statusCode = 404;
  res.end('{"ok":false}');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const tmpRoot = await mkdtemp(path.join(tmpdir(), 'dashbird-dev-requests-'));
const outRoot = path.join(tmpRoot, 'dev-requests');
const env = {
  ...process.env,
  DEV_REQUESTS_ROOT: outRoot,
  DEV_REQUESTS_DB_PATH: path.join(tmpRoot, 'dev-requests.db'),
};

try {
  const quiet = () => {};
  const first = await pullDevRequests({
    origin,
    statuses: ['open', 'done'],
    auth: { user: 'dashbird', pass: 'hunter2', deviceId: 'edd37155-3ffe-4d18-a775-d6cdcedbf343' },
    outRoot,
    requirePublicOrigin: false,
    log: quiet,
  });

  check(first.fetched === 3, 'fetched all statuses', first);
  check(first.written === 2, 'wrote only safe folders', first);
  check(first.skipped === 1, 'skipped traversal folder name', first);
  check(first.attachments === 1, 'downloaded only the valid screenshot', first);

  const folders = (await readdir(outRoot)).sort();
  check(
    folders.length === 2 && folders.every((f) => f.endsWith('aa11bb22') || f.endsWith('ee55ff66')),
    'folder names mirror the cloud',
    folders,
  );

  const openDir = path.join(outRoot, '20260805-064031-med-events-desktop-aa11bb22');
  const written = JSON.parse(await readFile(path.join(openDir, 'request.json'), 'utf8'));
  check(written.id === 'aa11bb22' && written.title === CLOUD.open[0].title, 'request.json content', written);
  check(!('path' in written), 'drops remote container path', written);
  check(
    Array.isArray(written.attachments) && written.attachments.length === 1 && written.attachments[0] === 'screenshot.png',
    'attachment list only keeps saved images',
    written.attachments,
  );
  const png = await readFile(path.join(openDir, 'screenshot.png'));
  check(png.equals(PNG), 'screenshot bytes match');
  const escaped = await readdir(tmpRoot);
  check(!escaped.includes('escape.png'), 'no attachment escaped the output root', escaped);

  const sentAuth = requestLog[0]?.auth || '';
  check(
    sentAuth === `Basic ${Buffer.from('dashbird:hunter2').toString('base64')}`,
    'sends basic auth when configured',
    sentAuth,
  );
  check(requestLog[0]?.cookie.includes('dashbird_did='), 'sends trusted device cookie', requestLog[0]?.cookie);

  const second = await pullDevRequests({
    origin,
    statuses: ['open', 'done'],
    outRoot,
    requirePublicOrigin: false,
    log: quiet,
  });
  check(second.written === 0 && second.skipped === 3, 'second pull is a no-op', second);

  const forced = await pullDevRequests({
    origin,
    statuses: ['open'],
    outRoot,
    force: true,
    requirePublicOrigin: false,
    log: quiet,
  });
  check(forced.written === 1, '--force rewrites unchanged folders', forced);

  // A local-only request must survive a pull + index rebuild.
  const localOnly = path.join(outRoot, '20260801-101010-high-notes-mobile-99887766');
  await mkdir(localOnly, { recursive: true });
  await writeFile(
    path.join(localOnly, 'request.json'),
    `${JSON.stringify(
      {
        id: '99887766',
        folder: path.basename(localOnly),
        title: 'Local only request',
        body: '',
        platform: 'mobile',
        area: 'notes',
        priority: 1,
        priorityLabel: 'High',
        status: 'open',
        attachments: [],
        createdAt: '2026-08-01T10:10:10.000Z',
        updatedAt: '2026-08-01T10:10:10.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await rebuildDevRequestsIndex(env);
  const indexed = listDevRequests({ status: 'open' }, env);
  check(indexed.length === 2, 'index has both open requests', indexed.map((r) => r.id));
  check(indexed.some((r) => r.id === '99887766'), 'local-only request preserved', indexed.map((r) => r.id));
  const done = listDevRequests({ status: 'done' }, env);
  check(done.length === 1 && done[0].id === 'ee55ff66', 'done request indexed', done.map((r) => r.id));

  const inbox = await readFile(path.join(outRoot, 'inbox.md'), 'utf8');
  check(inbox.includes('- [ ] **Replace sleep icon with zzz**'), 'inbox.md lists the pulled request');
  check(inbox.includes('screenshot.png'), 'inbox.md links the screenshot');
  check(!inbox.includes('Already shipped'), 'inbox.md omits done requests');

  let rejected = '';
  try {
    await pullDevRequests({ origin: 'http://127.0.0.1:1/', outRoot, log: quiet });
  } catch (e) {
    rejected = String(e?.message || e);
  }
  check(rejected === 'url_not_public', 'private origin rejected by URL policy', rejected);
} finally {
  server.close();
  await rm(tmpRoot, { recursive: true, force: true });
}

if (failed) {
  console.error(`dev-requests pull smoke: ${failed} failed`);
  process.exit(1);
}
console.log('dev-requests pull smoke: all passed');
