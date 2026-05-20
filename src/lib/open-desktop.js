import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

const DESKTOP_DIRS = [
  '/usr/share/applications',
  '/usr/local/share/applications',
  '/var/lib/flatpak/exports/share/applications',
  '/var/lib/snapd/desktop/applications',
];

/** Slug aliases → search tokens for AppImage filenames and .desktop names. */
const ID_ALIASES = {
  'org.kde.kdenlive': 'kdenlive',
  kdenlive: 'kdenlive',
};

function homeApplicationsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home ? path.join(home, '.local', 'share', 'applications') : '';
}

function hostApplicationsDirs() {
  const dirs = [];
  const fromEnv = (process.env.HOST_APPLICATIONS_DIR || '').trim();
  if (fromEnv) dirs.push(fromEnv);
  dirs.push('/host/Applications');
  const home = process.env.HOST_HOME || process.env.DASHBOARD_HOST_HOME || '';
  if (home) dirs.push(path.join(home, 'Applications'));
  const containerHome = process.env.HOME || '';
  if (containerHome) dirs.push(path.join(containerHome, 'Applications'));
  return [...new Set(dirs)];
}

function normalizeSlug(id) {
  const raw = String(id || '').trim();
  if (!raw || raw.includes('..') || raw.includes('/')) return '';
  return ID_ALIASES[raw] || raw.replace(/\.desktop$/i, '').replace(/^org\.kde\./, '');
}

function envOverridePath(slug) {
  const envKeys = [
    `OPEN_DESKTOP_${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
    slug === 'kdenlive' ? 'KDENLIVE_APPIMAGE' : '',
    slug === 'kdenlive' ? 'KDENLIVE_PATH' : '',
  ].filter(Boolean);
  for (const key of envKeys) {
    const v = (process.env[key] || '').trim();
    if (v) return v;
  }
  return '';
}

async function pathExists(fp) {
  try {
    await access(fp, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {string} slug
 * @returns {Promise<string|null>}
 */
async function findAppImageInDir(dir, slug) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const slugLower = slug.toLowerCase();
  const matches = names.filter(
    (n) => n.toLowerCase().includes(slugLower) && /\.AppImage$/i.test(n),
  );
  if (!matches.length) return null;
  matches.sort((a, b) => b.length - a.length);
  return path.join(dir, matches[0]);
}

/**
 * @param {string} slug
 * @returns {Promise<string|null>}
 */
async function resolveAppImagePath(slug) {
  const override = envOverridePath(slug);
  if (override && (await pathExists(override))) return override;

  for (const dir of hostApplicationsDirs()) {
    const fp = await findAppImageInDir(dir, slug);
    if (fp && (await pathExists(fp))) return fp;
  }
  return null;
}

/**
 * @param {string} slug
 * @returns {Promise<string|null>}
 */
async function resolveDesktopFilePath(slug) {
  const candidates = new Set();
  candidates.add(`${slug}.desktop`);
  candidates.add(`org.kde.${slug}.desktop`);
  candidates.add(`${slug}_${slug}.desktop`);
  if (/kdenlive/i.test(slug)) candidates.add('kdenlive_kdenlive.desktop');

  const dirs = [...DESKTOP_DIRS];
  const homeDir = homeApplicationsDir();
  if (homeDir) dirs.push(homeDir);

  for (const dir of dirs) {
    for (const name of candidates) {
      const fp = path.join(dir, name);
      if (await pathExists(fp)) return fp;
    }
  }
  return null;
}

/**
 * @param {string} id slug from URL (e.g. kdenlive or org.kde.kdenlive)
 * @returns {Promise<string|null>} path to .desktop or AppImage
 */
export async function resolveDesktopEntryPath(id) {
  const slug = normalizeSlug(id);
  if (!slug) return null;

  const appImage = await resolveAppImagePath(slug);
  if (appImage) return appImage;

  return resolveDesktopFilePath(slug);
}

function launchEnv() {
  const uid = process.env.DASHBOARD_HOST_UID || '1000';
  const hostHome = (process.env.HOST_HOME || process.env.DASHBOARD_HOST_HOME || '').trim();
  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':0',
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  };
  if (hostHome) env.HOME = hostHome;
  return env;
}

/**
 * Run a host AppImage from the container (mounted under /host/Applications).
 * APPIMAGE_EXTRACT_AND_RUN avoids FUSE, which is usually unavailable in Docker.
 * @param {string} appImagePath
 * @returns {Promise<void>}
 */
function openAppImage(appImagePath) {
  return new Promise((resolve, reject) => {
    const env = {
      ...launchEnv(),
      APPIMAGE_EXTRACT_AND_RUN: '1',
    };
    const child = spawn(appImagePath, [], { env, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.unref();
    resolve();
  });
}

/**
 * @param {string} targetPath .desktop or AppImage
 * @returns {Promise<void>}
 */
export async function openDesktopEntry(targetPath) {
  if (/\.AppImage$/i.test(targetPath)) {
    await openAppImage(targetPath);
    return;
  }
  return new Promise((resolve, reject) => {
    execFile('xdg-open', [targetPath], { env: launchEnv() }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
