/**
 * Weekly backup of Tool Library + Network contacts (SQLite + assets).
 * Default: Sunday 03:00 America/Los_Angeles → data/backups/tools-contacts-YYYY-MM-DD/
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { toolLibraryPath, toolLibraryAssetsDir } from './tool-library-store.js';
import { networkDbPath } from './network-db.js';
import { networkAssetsDir } from './network-contacts-store.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dataBackupWeeklyEnabled(env = process.env) {
  return String(env.DATA_BACKUP_WEEKLY ?? '1').trim() !== '0';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function dataBackupTz(env = process.env) {
  return (
    String(env.DATA_BACKUP_WEEKLY_TZ || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles'
  );
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ dow: number, hour: number, minute: number }}
 */
function dataBackupWhen(env = process.env) {
  const dowRaw = Number(env.DATA_BACKUP_WEEKLY_DOW);
  const hourRaw = Number(env.DATA_BACKUP_WEEKLY_HOUR);
  const minuteRaw = Number(env.DATA_BACKUP_WEEKLY_MINUTE);
  return {
    // Default Sunday (0)
    dow: Number.isFinite(dowRaw) && dowRaw >= 0 && dowRaw <= 6 ? Math.round(dowRaw) : 0,
    hour: Number.isFinite(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? Math.round(hourRaw) : 3,
    minute: Number.isFinite(minuteRaw) && minuteRaw >= 0 && minuteRaw <= 59 ? Math.round(minuteRaw) : 0,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dataBackupDir(env = process.env) {
  const override = String(env.DATA_BACKUP_DIR || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data', 'backups');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function dataBackupRetain(env = process.env) {
  const n = Number(env.DATA_BACKUP_RETAIN);
  if (Number.isFinite(n) && n >= 1 && n <= 52) return Math.round(n);
  return 8;
}

/**
 * Local calendar parts in the schedule timezone.
 * @param {Date} [now]
 * @param {string} [timeZone]
 */
export function dataBackupLocalParts(now = new Date(), timeZone = 'America/Los_Angeles') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  /** @type {Record<string, string>} */
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: wd[map.weekday] ?? -1,
    year: map.year,
    month: map.month,
    day: map.day,
    hour: Number(map.hour),
    minute: Number(map.minute),
    ymd: `${map.year}-${map.month}-${map.day}`,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Date} [now]
 */
export function shouldRunDataBackupWeekly(env = process.env, now = new Date()) {
  if (!dataBackupWeeklyEnabled(env)) return false;
  const when = dataBackupWhen(env);
  const local = dataBackupLocalParts(now, dataBackupTz(env));
  if (local.dow !== when.dow) return false;
  if (local.hour !== when.hour) return false;
  if (local.minute < when.minute || local.minute > when.minute + 1) return false;
  return true;
}

/**
 * Escape a path for use inside a single-quoted SQLite string literal.
 * @param {string} p
 */
function sqlQuotePath(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

/**
 * @param {string} src
 * @param {string} dest
 */
async function copyIfExists(src, dest) {
  try {
    await fsPromises.access(src);
  } catch {
    return false;
  }
  await fsPromises.mkdir(path.dirname(dest), { recursive: true });
  await fsPromises.cp(src, dest, { recursive: true, force: true, errorOnExist: false });
  return true;
}

/**
 * Consistent SQLite snapshot via VACUUM INTO (works with WAL).
 * @param {string} srcDb
 * @param {string} destDb
 */
function backupSqliteDb(srcDb, destDb) {
  if (!fs.existsSync(srcDb)) return false;
  fs.mkdirSync(path.dirname(destDb), { recursive: true });
  if (fs.existsSync(destDb)) fs.unlinkSync(destDb);
  const db = new DatabaseSync(srcDb);
  try {
    db.exec(`VACUUM INTO ${sqlQuotePath(destDb)}`);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return true;
}

/**
 * @param {string} dir
 * @param {number} retain
 */
async function pruneOldBackups(dir, retain) {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const folders = entries
    .filter((e) => e.isDirectory() && /^tools-contacts-\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const name of folders.slice(retain)) {
    await fsPromises.rm(path.join(dir, name), { recursive: true, force: true });
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} iso
 */
async function writeLastBackupStamp(env, iso) {
  const stampPath = path.join(PKG_ROOT, 'public', 'data', 'last-backup.txt');
  await fsPromises.mkdir(path.dirname(stampPath), { recursive: true });
  await fsPromises.writeFile(stampPath, `${iso}\n`, 'utf8');
  // Keep process.env in sync for /api/config within this process.
  env.LAST_BACKUP_AT = iso;
}

/**
 * Run one tools + contacts backup into data/backups/tools-contacts-YYYY-MM-DD/.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ ymd?: string }} [opts]
 * @returns {Promise<{ ok: boolean, dir?: string, ymd?: string, error?: string, copied?: Record<string, boolean> }>}
 */
export async function runToolsContactsBackup(env = process.env, opts = {}) {
  const tz = dataBackupTz(env);
  const ymd = opts.ymd || dataBackupLocalParts(new Date(), tz).ymd;
  const root = dataBackupDir(env);
  const destDir = path.join(root, `tools-contacts-${ymd}`);
  const staging = `${destDir}.tmp.${process.pid}.${Date.now()}`;

  try {
    await fsPromises.mkdir(staging, { recursive: true });

    const copied = {
      toolLibrary: false,
      toolLibraryAssets: false,
      networkDb: false,
      networkAssets: false,
    };

    copied.toolLibrary = await copyIfExists(
      toolLibraryPath(env),
      path.join(staging, 'tool-library.json'),
    );
    copied.toolLibraryAssets = await copyIfExists(
      toolLibraryAssetsDir(env),
      path.join(staging, 'tool-library-assets'),
    );
    copied.networkDb = backupSqliteDb(networkDbPath(env), path.join(staging, 'network.db'));
    copied.networkAssets = await copyIfExists(
      networkAssetsDir(env),
      path.join(staging, 'network-assets'),
    );

    const iso = new Date().toISOString();
    const manifest = {
      kind: 'tools-contacts',
      ymd,
      createdAt: iso,
      timeZone: tz,
      sources: {
        toolLibrary: toolLibraryPath(env),
        toolLibraryAssets: toolLibraryAssetsDir(env),
        networkDb: networkDbPath(env),
        networkAssets: networkAssetsDir(env),
      },
      copied,
    };
    await fsPromises.writeFile(
      path.join(staging, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    await fsPromises.mkdir(root, { recursive: true });
    await fsPromises.rm(destDir, { recursive: true, force: true });
    await fsPromises.rename(staging, destDir);

    await pruneOldBackups(root, dataBackupRetain(env));
    await writeLastBackupStamp(env, iso);

    return { ok: true, dir: destDir, ymd, copied };
  } catch (e) {
    await fsPromises.rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: e?.message || String(e), ymd };
  }
}

/** @type {string | null} */
let lastBackupYmd = null;
/** @type {ReturnType<typeof setInterval> | null} */
let backupTimer = null;
let backupInFlight = false;

/**
 * Seed same-day dedupe from an existing backup folder (survives restarts).
 * @param {NodeJS.ProcessEnv} [env]
 */
async function seedLastBackupYmd(env = process.env) {
  const tz = dataBackupTz(env);
  const when = dataBackupWhen(env);
  const nowLocal = dataBackupLocalParts(new Date(), tz);
  const expected = path.join(dataBackupDir(env), `tools-contacts-${nowLocal.ymd}`);
  try {
    const st = await fsPromises.stat(expected);
    if (!st.isDirectory()) return;
    const afterSlot =
      nowLocal.hour > when.hour
      || (nowLocal.hour === when.hour && nowLocal.minute >= when.minute);
    if (nowLocal.dow === when.dow && afterSlot) {
      lastBackupYmd = nowLocal.ymd;
    }
  } catch {
    /* no backup yet today */
  }
}

/**
 * Start weekly tools + contacts backup scheduler.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startToolsContactsBackupScheduler(env = process.env) {
  if (!dataBackupWeeklyEnabled(env)) {
    console.log('[data-backup] weekly tools+contacts backup disabled');
    return;
  }
  if (backupTimer) return;

  const when = dataBackupWhen(env);
  const tz = dataBackupTz(env);
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const whenLabel = `${dowNames[when.dow]} ${String(when.hour).padStart(2, '0')}:${String(when.minute).padStart(2, '0')}`;
  console.log(`[data-backup] weekly tools+contacts: ${whenLabel} ${tz} → ${dataBackupDir(env)}`);

  const tick = async () => {
    if (backupInFlight) return;
    if (!shouldRunDataBackupWeekly(env)) return;
    const ymd = dataBackupLocalParts(new Date(), tz).ymd;
    if (lastBackupYmd === ymd) return;
    backupInFlight = true;
    lastBackupYmd = ymd;
    console.log(`[data-backup] weekly backup starting (${ymd})`);
    try {
      const result = await runToolsContactsBackup(env, { ymd });
      if (result.ok) {
        console.log(`[data-backup] weekly backup done → ${result.dir}`);
      } else {
        console.warn(`[data-backup] weekly backup failed: ${result.error}`);
        lastBackupYmd = null;
      }
    } catch (e) {
      console.warn('[data-backup] weekly backup failed', e?.message || e);
      lastBackupYmd = null;
    } finally {
      backupInFlight = false;
    }
  };

  void seedLastBackupYmd(env).catch(() => {});

  backupTimer = setInterval(() => {
    void tick();
  }, 60_000);
  if (typeof backupTimer.unref === 'function') backupTimer.unref();
  setTimeout(() => {
    void tick();
  }, 20_000);
}
