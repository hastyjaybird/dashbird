/** Persistent Dashbird device ID (cloud trusted-device allowlist). */
const STORAGE_KEY = 'dashbird_did';
const COOKIE_NAME = 'dashbird_did';

function readCookie(name) {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function writeCookie(id) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; SameSite=Lax; Max-Age=31536000${secure}`;
}

function createDeviceId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * @returns {string}
 */
export function getOrCreateDeviceId() {
  let id = readCookie(COOKIE_NAME);
  if (!id) {
    try {
      id = String(localStorage.getItem(STORAGE_KEY) || '').trim();
    } catch {
      id = '';
    }
  }
  if (!id) {
    id = createDeviceId();
  }
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
  writeCookie(id);
  return id;
}

/** Sync localStorage device ID to cookie before API calls (cloud basic-auth bypass). */
export function syncDeviceIdCookie() {
  return getOrCreateDeviceId();
}
