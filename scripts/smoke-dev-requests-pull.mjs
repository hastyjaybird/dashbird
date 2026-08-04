#!/usr/bin/env node
/**
 * Smoke: pull dev requests over HTTP from a stand-in cloud dashboard into a scratch root.
 * Covers basic auth, attachment download, path-traversal rejection, and inbox regeneration.
 * Usage: node scripts/smoke-dev-requests-pull.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER = 'dashbird';
const PASS = 'smoke-pass-1234';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 1x1 transparent PNG. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');

/**
 * @param {string} cloudRoot
 */
function startCloud(cloudRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/fixtures/dev-requests-cloud-server.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEV_REQUESTS_ROOT: cloudRoot,
        DEV_REQUESTS_DB_PATH: path.join(cloudRoot, 'dev-requests.db'),
        FAKE_CLOUD_USER: USER,
        FAKE_CLOUD_PASS: PASS,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('cloud server did not start')), 20_000);
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      const m = out.match(/listening (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[cloud] ${chunk}`));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloud server exited early (${code})`));
    });
  });
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function runPull(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/pull-dev-requests.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += String(c);
    });
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'dashbird-dev-requests-'));
const cloudRoot = path.join(tmp, 'cloud');
const localRoot = path.join(tmp, 'local');
const localEnv = {
  DEV_REQUESTS_ROOT: localRoot,
  DEV_REQUESTS_DB_PATH: path.join(localRoot, 'dev-requests.db'),
  DASHBIRD_CLOUD_USER: USER,
  DASHBIRD_CLOUD_PASS: PASS,
};

let cloud;
try {
  cloud = await startCloud(cloudRoot);
  const base = `http://127.0.0.1:${cloud.port}`;
  const auth = `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`;

  const unauth = await fetch(`${base}/api/dev-requests?status=open`);
  assert(unauth.status === 401, `expected 401 without credentials, got ${unauth.status}`);

  const seeds = [
    {
      title: 'Mobile Events list needs bigger tap targets',
      body: 'Rows are hard to hit one-handed.',
      platform: 'mobile',
      area: 'events',
      priority: 1,
      attachments: [{ base64: PNG_B64, mimeType: 'image/png', filename: 'events-list.png' }],
    },
    {
      title: 'Settings Costs should show monthly total',
      body: 'Weekly only today.',
      platform: 'desktop',
      area: 'settings',
      priority: 2,
    },
  ];
  /** @type {string[]} */
  const seededIds = [];
  for (const seed of seeds) {
    const res = await fetch(`${base}/api/dev-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(seed),
    });
    const data = await res.json();
    assert(res.status === 201 && data?.ok, `seed failed: ${res.status} ${JSON.stringify(data)}`);
    seededIds.push(data.request.id);
  }

  const done = await fetch(`${base}/api/dev-requests/${seededIds[1]}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ status: 'done' }),
  });
  assert(done.ok, 'marking second request done failed');

  const noCreds = await runPull([`--url=${base}`, '--allow-private'], {
    ...localEnv,
    DASHBIRD_CLOUD_PASS: '',
  });
  assert(noCreds.code !== 0, 'pull without a password should fail');
  assert(
    /401/.test(noCreds.stdout + noCreds.stderr),
    `expected a 401 hint, got: ${noCreds.stderr || noCreds.stdout}`,
  );

  const priv = await runPull([`--url=${base}`], localEnv);
  assert(priv.code !== 0, 'private URL should be refused without --allow-private');
  assert(
    /non-public/.test(priv.stdout + priv.stderr),
    `expected non-public refusal, got: ${priv.stderr || priv.stdout}`,
  );

  const dry = await runPull([`--url=${base}`, '--allow-private', '--dry-run'], localEnv);
  assert(dry.code === 0, `dry run failed: ${dry.stderr}`);
  assert(/would write/.test(dry.stdout), 'dry run should list requests');
  let localEntries = [];
  try {
    localEntries = await readdir(localRoot);
  } catch {
    localEntries = [];
  }
  assert(localEntries.length === 0, `dry run wrote files: ${localEntries.join(', ')}`);

  const pull = await runPull([`--url=${base}`, '--allow-private'], localEnv);
  assert(pull.code === 0, `pull failed: ${pull.stderr}`);

  const folders = (await readdir(localRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert(folders.length === 1, `expected only the open request, got ${folders.length}`);

  const openFolder = folders[0];
  const record = JSON.parse(await readFile(path.join(localRoot, openFolder, 'request.json'), 'utf8'));
  assert(record.title === seeds[0].title, `title mismatch: ${record.title}`);
  assert(record.priority === 1, `priority mismatch: ${record.priority}`);
  assert(record.pulledFrom === base, `pulledFrom mismatch: ${record.pulledFrom}`);
  assert(record.attachments.includes('events-list.png'), 'attachment missing from record');

  const png = await readFile(path.join(localRoot, openFolder, 'events-list.png'));
  assert(png.equals(PNG_BYTES), 'attachment bytes differ from the cloud copy');

  const inbox = await readFile(path.join(localRoot, 'inbox.md'), 'utf8');
  assert(inbox.includes(seeds[0].title), 'inbox missing the open request');
  assert(!inbox.includes(seeds[1].title), 'inbox should not list the done request');
  assert(inbox.includes(`${openFolder}/`), 'inbox missing the folder link');

  const both = await runPull([`--url=${base}`, '--allow-private', '--all'], localEnv);
  assert(both.code === 0, `--all pull failed: ${both.stderr}`);
  const allFolders = (await readdir(localRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert(allFolders.length === 2, `expected open + done folders, got ${allFolders.length}`);

  const traversalRes = await fetch(
    `${base}/api/dev-requests/${seededIds[0]}/files/${encodeURIComponent('../../../etc/passwd')}`,
    { headers: { Authorization: auth } },
  );
  assert(traversalRes.status === 404, `traversal fetch should 404, got ${traversalRes.status}`);

  console.log(`smoke-dev-requests-pull: ok (${allFolders.length} folders, 1 attachment)`);
} finally {
  if (cloud?.child?.pid) {
    cloud.child.removeAllListeners('exit');
    cloud.child.kill('SIGTERM');
  }
  await rm(tmp, { recursive: true, force: true });
}
