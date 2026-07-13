#!/usr/bin/env node
/**
 * Restore Tool Library + Network contacts from data/backups/tools-contacts-YYYY-MM-DD/.
 *
 * Usage:
 *   node scripts/restore-tools-contacts-backup.mjs           # latest backup
 *   node scripts/restore-tools-contacts-backup.mjs 2026-07-12
 *   node scripts/restore-tools-contacts-backup.mjs --list
 *
 * Stop the dashboard container first (or run via `docker compose down` then this,
 * then `docker compose up -d`) so SQLite is not open during the copy.
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BACKUP_ROOT = path.join(PKG_ROOT, 'data', 'backups');

/**
 * @param {string} dir
 */
async function listBackupDirs(dir) {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^tools-contacts-\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * @param {string} src
 * @param {string} dest
 */
async function copyPath(src, dest) {
  const st = await fsPromises.stat(src);
  if (st.isDirectory()) {
    await fsPromises.rm(dest, { recursive: true, force: true });
    await fsPromises.cp(src, dest, { recursive: true });
  } else {
    await fsPromises.mkdir(path.dirname(dest), { recursive: true });
    await fsPromises.copyFile(src, dest);
  }
}

async function main() {
  const arg = process.argv[2] || '';
  const folders = await listBackupDirs(BACKUP_ROOT);
  if (arg === '--list' || arg === '-l') {
    if (!folders.length) {
      console.log('No tools-contacts backups in', BACKUP_ROOT);
      return;
    }
    for (const name of folders) console.log(name);
    return;
  }

  if (!folders.length) {
    console.error('No backups found under', BACKUP_ROOT);
    process.exit(1);
  }

  let folderName;
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    folderName = `tools-contacts-${arg}`;
    if (!folders.includes(folderName)) {
      console.error(`Backup not found: ${folderName}`);
      console.error('Available:', folders.join(', '));
      process.exit(1);
    }
  } else if (!arg) {
    folderName = folders[0];
  } else {
    console.error('Usage: node scripts/restore-tools-contacts-backup.mjs [YYYY-MM-DD|--list]');
    process.exit(1);
  }

  const srcDir = path.join(BACKUP_ROOT, folderName);
  const manifestPath = path.join(srcDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('Missing manifest.json in', srcDir);
    process.exit(1);
  }

  console.log(`Restoring from ${folderName} …`);
  const pairs = [
    ['network.db', 'data/network.db'],
    ['network-assets', 'data/network-assets'],
    ['tool-library.json', 'data/tool-library.json'],
    ['tool-library-assets', 'data/tool-library-assets'],
  ];
  for (const [from, to] of pairs) {
    const src = path.join(srcDir, from);
    const dest = path.join(PKG_ROOT, to);
    if (!fs.existsSync(src)) {
      console.log(`  skip missing ${from}`);
      continue;
    }
    await copyPath(src, dest);
    console.log(`  restored ${to}`);
  }
  // Drop WAL sidecars so the restored DB is authoritative.
  for (const side of ['data/network.db-wal', 'data/network.db-shm']) {
    await fsPromises.rm(path.join(PKG_ROOT, side), { force: true });
  }
  console.log('Done. Start the stack with: docker compose up -d --build');
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
