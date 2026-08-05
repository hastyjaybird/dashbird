/**
 * Email → Events: known + learned event-platform hosts.
 * Seed hosts ship in src/data; learned misses append to data/events-finder-email-platforms.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(
  __dirname,
  '../data/events-finder-email-platforms.default.json',
);

/**
 * @returns {string}
 */
function livePath() {
  const fromEnv = String(process.env.EVENTS_FINDER_EMAIL_PLATFORMS_PATH || '').trim();
  if (fromEnv) return fromEnv;
  return path.join(process.cwd(), 'data', 'events-finder-email-platforms.json');
}

/**
 * @param {unknown} raw
 * @returns {{ hosts: string[], notes: Record<string, string>, learned: Array<{ host: string, reason?: string, at?: string }> }}
 */
function normalizeDoc(raw) {
  const obj = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const hosts = Array.isArray(obj.hosts)
    ? obj.hosts.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const notes =
    obj.notes && typeof obj.notes === 'object' && !Array.isArray(obj.notes)
      ? /** @type {Record<string, string>} */ (obj.notes)
      : {};
  const learned = Array.isArray(obj.learned)
    ? obj.learned
      .map((row) => {
        if (!row || typeof row !== 'object') return null;
        const host = String(/** @type {Record<string, unknown>} */ (row).host || '')
          .trim()
          .toLowerCase();
        if (!host) return null;
        return {
          host,
          reason: String(/** @type {Record<string, unknown>} */ (row).reason || '').slice(0, 240) || undefined,
          at: String(/** @type {Record<string, unknown>} */ (row).at || '') || undefined,
        };
      })
      .filter(Boolean)
    : [];
  return { hosts: [...new Set(hosts)], notes, learned: /** @type {any[]} */ (learned) };
}

/**
 * @returns {{ hosts: string[], notes: Record<string, string>, learned: Array<{ host: string, reason?: string, at?: string }> }}
 */
export function loadEmailPlatformDoc() {
  /** @type {Record<string, unknown>} */
  let base = { hosts: [], notes: {}, learned: [] };
  try {
    base = JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf8'));
  } catch {
    /* keep empty */
  }
  const merged = normalizeDoc(base);
  try {
    if (fs.existsSync(livePath())) {
      const live = normalizeDoc(JSON.parse(fs.readFileSync(livePath(), 'utf8')));
      merged.hosts = [...new Set([...merged.hosts, ...live.hosts, ...live.learned.map((r) => r.host)])];
      merged.notes = { ...merged.notes, ...live.notes };
      merged.learned = live.learned;
    }
  } catch {
    /* ignore corrupt live file */
  }
  return merged;
}

/** @type {Set<string> | null} */
let hostCache = null;

/**
 * @returns {Set<string>}
 */
export function emailPlatformHostSet() {
  if (!hostCache) {
    const doc = loadEmailPlatformDoc();
    hostCache = new Set(doc.hosts);
    for (const row of doc.learned) hostCache.add(row.host);
  }
  return hostCache;
}

/**
 * @param {string} hrefOrHost
 * @returns {string | null}
 */
export function hostnameFromHref(hrefOrHost) {
  const raw = String(hrefOrHost || '').trim().toLowerCase();
  if (!raw) return null;
  try {
    const u = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return raw.replace(/^www\./, '') || null;
  }
}

/**
 * @param {string} hrefOrHost
 * @returns {boolean}
 */
export function isWhitelistedEventPlatformHost(hrefOrHost) {
  const host = hostnameFromHref(hrefOrHost);
  if (!host) return false;
  const set = emailPlatformHostSet();
  if (set.has(host)) return true;
  for (const known of set) {
    if (host.endsWith(`.${known}`)) return true;
  }
  return false;
}

/**
 * Catalog source key for a whitelisted (or known) host.
 * @param {string} hrefOrHost
 * @returns {string | null}
 */
export function sourceKeyForEmailPlatform(hrefOrHost) {
  const host = hostnameFromHref(hrefOrHost);
  if (!host) return null;
  if (host === 'withjoy.com' || host.endsWith('.withjoy.com')) return 'withjoy';
  if (host.includes('fuckupnights')) return 'fuckupnights';
  if (host === 'lu.ma' || host === 'luma.com' || host.endsWith('.luma.com')) return 'luma';
  if (host.includes('secretparty')) return 'secretparty';
  if (host.includes('partiful')) return 'partiful';
  if (host.includes('eventbrite')) return 'eventbrite';
  if (host.includes('meetup')) return 'meetup';
  if (host.includes('plra.io')) return 'plura';
  if (host.includes('wannaketchup')) return 'wannaketchup';
  if (host.includes('bonobo')) return 'bonobo';
  if (host.includes('take3presents')) return 'take3presents';
  if (isWhitelistedEventPlatformHost(host)) {
    const base = host.split('.').slice(-2).join('.');
    return base.replace(/\./g, '_');
  }
  return null;
}

/**
 * Remember a host that yielded event dates via link-follow (grows the whitelist).
 * @param {string} hrefOrHost
 * @param {string} [reason]
 */
export function rememberEmailPlatformHost(hrefOrHost, reason = 'link_follow_enrich') {
  const host = hostnameFromHref(hrefOrHost);
  if (!host || host.length < 3) return;
  if (isWhitelistedEventPlatformHost(host)) {
    // Still refresh cache membership for subdomain parents.
    emailPlatformHostSet().add(host);
    return;
  }
  const file = livePath();
  /** @type {ReturnType<typeof normalizeDoc>} */
  let doc = { hosts: [], notes: {}, learned: [] };
  try {
    if (fs.existsSync(file)) doc = normalizeDoc(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    doc = { hosts: [], notes: {}, learned: [] };
  }
  if (!doc.learned.some((r) => r.host === host) && !doc.hosts.includes(host)) {
    doc.learned.push({ host, reason: String(reason || '').slice(0, 240), at: new Date().toISOString() });
  }
  if (!doc.hosts.includes(host)) doc.hosts.push(host);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn('[events-finder] email platform whitelist write failed:', e?.message || e);
  }
  emailPlatformHostSet().add(host);
  hostCache = null;
}

/**
 * Reset in-memory cache (tests).
 */
export function resetEmailPlatformHostCache() {
  hostCache = null;
}
