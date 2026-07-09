/**
 * Shared outbound URL policy for Tool Library scrape / screenshot / image download.
 * Rejects non-http(s), blocked hostnames, and private/link-local/metadata addresses
 * (including after DNS resolution and decimal/octal IPv4 host forms).
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

/**
 * @param {string} ip
 */
export function isPrivateOrReservedIp(ip) {
  const addr = String(ip || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!addr) return true;

  if (net.isIPv4(addr)) {
    const parts = addr.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (net.isIPv6(addr)) {
    if (addr === '::' || addr === '::1') return true;
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // ULA
    if (addr.startsWith('fe80')) return true; // link-local
    if (addr.startsWith('ff')) return true; // multicast
    // IPv4-mapped IPv6
    const mapped =
      addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i) ||
      addr.match(/^:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }

  return true;
}

/**
 * Expand dotted / decimal / octal-ish IPv4 hostname forms to a canonical IP string.
 * @param {string} host
 * @returns {string | null}
 */
function coerceHostnameToIp(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return null;
  if (net.isIP(h)) return h;

  // Decimal IPv4 (e.g. 2130706433 → 127.0.0.1)
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }

  // Dotted forms with non-decimal octets (octal/hex) — reject by treating as suspicious IP-like
  if (/^[\d.]+$/.test(h) && h.includes('.')) {
    const parts = h.split('.');
    if (parts.length === 4 && parts.every((p) => /^(0x[\da-f]+|\d+)$/i.test(p))) {
      const nums = parts.map((p) => (/^0x/i.test(p) ? parseInt(p, 16) : parseInt(p, 10)));
      if (nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
        return nums.join('.');
      }
    }
  }

  return null;
}

/**
 * @param {string} hostname
 */
function isBlockedHostname(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (host.endsWith('.nip.io') || host.endsWith('.sslip.io')) return true;
  return false;
}

/**
 * Validate that a URL is http(s) and resolves only to public addresses.
 * @param {string} urlString
 * @returns {Promise<string>} normalized href
 */
export async function assertPublicHttpUrl(urlString) {
  let u;
  try {
    u = new URL(String(urlString || '').trim());
  } catch {
    throw new Error('url_not_public');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('url_not_public');
  }
  if (u.username || u.password) {
    throw new Error('url_not_public');
  }

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) {
    throw new Error('url_not_public');
  }

  const asIp = coerceHostnameToIp(host);
  if (asIp) {
    if (isPrivateOrReservedIp(asIp)) throw new Error('url_not_public');
    return u.toString();
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('url_not_public');
  }
  if (!records?.length) throw new Error('url_not_public');
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) throw new Error('url_not_public');
  }
  return u.toString();
}

/**
 * Sync string-level check (no DNS). Prefer assertPublicHttpUrl before network I/O.
 * @param {string} urlString
 */
export function looksLikePublicHttpUrl(urlString) {
  try {
    const u = new URL(String(urlString || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isBlockedHostname(host)) return false;
    const asIp = coerceHostnameToIp(host);
    if (asIp) return !isPrivateOrReservedIp(asIp);
    return Boolean(host);
  } catch {
    return false;
  }
}
