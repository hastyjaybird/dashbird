/**
 * Smoke: pull dev requests from a stub dashboard — screenshots, and hostile folder /
 * attachment names coming off the wire.
 * Usage: node scripts/smoke-dev-requests-pull.mjs
 *
 * Exercises pullDevRequests() directly against a loopback stub; the public-URL guard lives in
 * the script's CLI path, so the real cloud target still has to be a public https origin.
 */
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pullDevRequests, safeSegment, toRequestJson } from './pull-dev-requests-from-cloud.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

const GOOD_FOLDER = '20260805-000000-med-events-desktop-aabbccdd';

const OPEN_REQUESTS = [
  {
    id: 'aabbccdd',
    folder: GOOD_FOLDER,
    title: 'Screenshot request',
    body: 'has one usable screenshot',
    platform: 'desktop',
    area: 'events',
    areaLabel: 'Events',
    section: null,
    priority: 2,
    priorityLabel: 'Med',
    status: 'open',
    attachments: ['shot.png', '../../evil.png', 'notes.txt', 'empty.png'],
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    path: '/app/data/dev-requests/20260805-000000-med-events-desktop-aabbccdd',
  },
  {
    id: 'deadbeef',
    folder: '../escape-me',
    title: 'Path traversal attempt',
    body: '',
    platform: 'desktop',
    area: 'events',
    areaLabel: 'Events',
    section: null,
    priority: 1,
    priorityLabel: 'High',
    status: 'open',
    attachments: [],
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    path: '/app/data/dev-requests/escape-me',
  },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/dev-requests') {
    const status = url.searchParams.get('status') || 'open';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, requests: status === 'open' ? OPEN_REQUESTS : [] }));
    return;
  }
  if (url.pathname === '/api/dev-requests/aabbccdd/files/shot.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(PNG_BYTES);
    return;
  }
  if (url.pathname === '/api/dev-requests/aabbccdd/files/empty.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(Buffer.alloc(0));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const tmpParent = await mkdtemp(path.join(os.tmpdir(), 'dashbird-pull-'));
const root = path.join(tmpParent, 'dev-requests');

try {
  assert(safeSegment('../escape') === '', 'traversal segment rejected');
  assert(safeSegment('a/b.png') === '', 'nested name rejected, not reduced');
  assert(safeSegment('.hidden') === '', 'leading-dot name rejected');
  assert(safeSegment(GOOD_FOLDER) === GOOD_FOLDER, 'normal folder accepted');
  assert(!('path' in toRequestJson({ id: 'x', path: '/app/data/x' }, [])), 'remote container path stripped');

  const dry = await pullDevRequests(`http://127.0.0.1:${port}`, ['open'], { root, dryRun: true, log: () => {} });
  assert(dry.folders.length === 1 && dry.skipped === 1, `dry run counts: ${JSON.stringify(dry)}`);
  assert(!existsSync(root), 'dry run wrote nothing');

  const result = await pullDevRequests(`http://127.0.0.1:${port}`, ['open', 'done'], { root, log: () => {} });
  assert(result.folders.length === 1, `one request written, got ${result.folders.length}`);
  assert(result.skipped === 1, 'traversal request skipped');
  assert(result.attachments === 1, `one screenshot saved, got ${result.attachments}`);

  const dirs = (await readdir(tmpParent, { withFileTypes: true })).map((d) => d.name);
  assert(dirs.length === 1 && dirs[0] === 'dev-requests', `nothing escaped the root: ${dirs.join(', ')}`);

  const written = (await readdir(root)).sort();
  assert(written.length === 1 && written[0] === GOOD_FOLDER, `only the safe folder exists: ${written.join(', ')}`);

  const files = (await readdir(path.join(root, GOOD_FOLDER))).sort();
  assert(files.join(',') === 'request.json,shot.png', `folder contents: ${files.join(',')}`);

  const saved = await readFile(path.join(root, GOOD_FOLDER, 'shot.png'));
  assert(saved.equals(PNG_BYTES), 'screenshot bytes round-tripped');

  const json = JSON.parse(await readFile(path.join(root, GOOD_FOLDER, 'request.json'), 'utf8'));
  assert(json.id === 'aabbccdd' && json.title === 'Screenshot request', 'request fields preserved');
  assert(!('path' in json), 'container path not persisted locally');
  assert(
    Array.isArray(json.attachments) && json.attachments.length === 1 && json.attachments[0] === 'shot.png',
    `attachments narrowed to what was saved: ${JSON.stringify(json.attachments)}`,
  );
} finally {
  server.close();
  await rm(tmpParent, { recursive: true, force: true });
}

console.log('smoke-dev-requests-pull: ok');
