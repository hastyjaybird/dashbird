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
    id = crypto.randomUUID();
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
