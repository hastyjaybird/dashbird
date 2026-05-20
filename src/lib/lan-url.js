import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');

/** @returns {number} */
export function readHostPort() {
  const fromEnv = Number(process.env.HOST_PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;

  let port = 8787;
  const envPath = path.join(root, '.env');
  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, 'utf8');
    const m = raw.match(/^HOST_PORT=(.+)$/m);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, '');
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) port = n;
    }
  }
  return port;
}

/** @returns {string|null} */
export function pickLanIp() {
  try {
    const out = execSync('ip -4 -o addr show scope global 2>/dev/null', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const line = out.trim().split('\n')[0];
    if (line) {
      const parts = line.split(/\s+/);
      const addr = parts[3];
      if (addr) return addr.split('/')[0];
    }
  } catch {
    /* ignore */
  }
  try {
    const out = execSync('hostname -I 2>/dev/null', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const ip = out.trim().split(/\s+/)[0];
    if (ip) return ip;
  } catch {
    /* ignore */
  }
  return null;
}

/** @returns {string|null} */
export function getLanUrl() {
  const ip = pickLanIp();
  if (!ip) return null;
  const port = readHostPort();
  return `http://${ip}:${port}/`;
}

/** @returns {string|null} */
export function printLanUrl() {
  const url = getLanUrl();
  if (!url) {
    console.warn(
      '[dashbird] Could not detect LAN IP for phone access. Set DASHBOARD_LAN_ORIGIN in .env.',
    );
    return null;
  }
  console.log(`[dashbird] Phone (same Wi-Fi): ${url}`);
  return url;
}
