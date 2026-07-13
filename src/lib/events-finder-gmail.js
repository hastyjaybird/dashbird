/**
 * Events finder — Gmail intake (multi-account).
 * Default inboxes: jay.intake.box@gmail.com + julia.hasty@gmail.com.
 * OAuth2 refresh tokens on disk; Gmail API list + parse (.ics / RSVP links / heuristics).
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIcsEvents } from './ical-parse.js';
import {
  eventsIngestWindowDays,
  filterEventsToIngestWindow,
} from './events-finder-window.js';
import { loadEventsFinderCriteria } from './events-finder-criteria-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

export const GMAIL_INTAKE_DEFAULT_ADDRESSES = [
  'jay.intake.box@gmail.com',
  'julia.hasty@gmail.com',
];
/** @deprecated use GMAIL_INTAKE_DEFAULT_ADDRESSES[0] */
export const GMAIL_INTAKE_DEFAULT_ADDRESS = GMAIL_INTAKE_DEFAULT_ADDRESSES[0];
export const GMAIL_EVENTS_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

/** @type {Promise<object> | null} */
let gmailEventsInflight = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function gmailEventsCachePath(env = process.env) {
  const override = String(env.GMAIL_EVENTS_CACHE_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(root, override);
  }
  return path.join(root, 'data', 'gmail-events-cache.json');
}

/**
 * Disk TTL for intake parse results. IMAP is ~10–20s; do not re-hit on every sidebar open.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function gmailEventsCacheTtlMs(env = process.env) {
  const raw = Number(env.GMAIL_EVENTS_CACHE_MS);
  if (Number.isFinite(raw) && raw >= 60_000) return raw;
  return 30 * 60 * 1000;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readGmailEventsCache(env = process.env) {
  try {
    const raw = await readFile(gmailEventsCachePath(env), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {object} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeGmailEventsCache(payload, env = process.env) {
  const p = gmailEventsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * @param {string[]} addresses
 * @param {string} query
 * @param {{ pastDays?: number, futureDays?: number, windowWeeks?: number } | null | undefined} windowDays
 */
function gmailCacheFingerprint(addresses, query, windowDays) {
  return JSON.stringify({
    addresses: [...addresses].map((a) => String(a || '').toLowerCase()).sort(),
    query: String(query || ''),
    pastDays: windowDays?.pastDays ?? null,
    futureDays: windowDays?.futureDays ?? null,
    windowWeeks: windowDays?.windowWeeks ?? null,
  });
}

/**
 * @param {object | null} cache
 * @param {string} fingerprint
 * @param {NodeJS.ProcessEnv} [env]
 */
function gmailCacheFresh(cache, fingerprint, env = process.env) {
  if (!cache?.cachedAt || cache.fingerprint !== fingerprint) return false;
  const age = Date.now() - Date.parse(cache.cachedAt);
  return Number.isFinite(age) && age >= 0 && age < gmailEventsCacheTtlMs(env);
}

const DEFAULT_QUERY =
  'newer_than:35d (filename:ics OR subject:(invite OR invitation OR RSVP OR event OR meetup OR "you\'re invited" OR "join us") OR from:(partiful.com OR secretparty.io OR lu.ma OR eventbrite.com OR meetup.com OR facebookmail.com OR metamail.com OR facebook.com))';

/**
 * Public event / invite links. Facebook: /events/{id}, page hosted tabs, group events.
 * Secret Party events are usually https://<slug>.secretparty.io/ (subdomain), not path URLs.
 */
const PLATFORM_HOST_RE =
  /(?:https?:\/\/)?(?:(?:[a-z0-9-]+)\.)?secretparty\.io(?:\/[^\s"'<>)\]]*)?|(?:https?:\/\/)?(?:www\.)?(?:partiful\.com|lu\.ma|luma\.com|eventbrite\.com|meetup\.com|facebook\.com\/(?:events\/[^\s"'<>)\]]+|[^/\s"'<>)\]]+\/(?:upcoming_hosted_events|past_hosted_events|events)|groups\/[^/\s"'<>)\]]+\/events)[^\s"'<>)\]]*)/gi;

/**
 * @param {string} email
 */
export function normalizeGmailAddress(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Configured intake mailboxes (order preserved, deduped).
 * Env: GMAIL_INTAKE_ADDRESSES=a@x.com,b@y.com
 * Legacy: GMAIL_INTAKE_ADDRESS alone still works (single or first of list).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function gmailIntakeAddresses(env = process.env) {
  const multi = String(env.GMAIL_INTAKE_ADDRESSES || '').trim();
  const single = String(env.GMAIL_INTAKE_ADDRESS || '').trim();
  /** @type {string[]} */
  let list = [];
  if (multi) {
    list = multi.split(/[,;\s]+/).map(normalizeGmailAddress).filter(Boolean);
  } else if (single) {
    list = single.split(/[,;\s]+/).map(normalizeGmailAddress).filter(Boolean);
  } else {
    list = [...GMAIL_INTAKE_DEFAULT_ADDRESSES];
  }
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const e of list) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out.length ? out : [...GMAIL_INTAKE_DEFAULT_ADDRESSES];
}

/**
 * Primary / first intake address (backward compatible).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailIntakeAddress(env = process.env) {
  return gmailIntakeAddresses(env)[0] || GMAIL_INTAKE_DEFAULT_ADDRESS;
}

/**
 * App password for IMAP fallback (avoids Google OAuth consent UI).
 * Prefer GMAIL_INTAKE_APP_PASSWORD_<SLUG> or GMAIL_INTAKE_APP_PASSWORD for primary.
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailAppPasswordFor(email, env = process.env) {
  const addr = normalizeGmailAddress(email);
  if (!addr) return '';
  const slug = gmailTokenFileSlug(addr)
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
  const specific = String(env[`GMAIL_INTAKE_APP_PASSWORD_${slug}`] || '').trim();
  if (specific) return specific.replace(/\s+/g, '');
  const primary = String(env.GMAIL_INTAKE_APP_PASSWORD || '').trim().replace(/\s+/g, '');
  if (!primary) return '';
  const addresses = gmailIntakeAddresses(env);
  if (addresses[0] === addr || addresses.length === 1) return primary;
  return '';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailEventsQuery(env = process.env) {
  const q = String(env.GMAIL_EVENTS_QUERY || '').trim();
  return q || DEFAULT_QUERY;
}

/**
 * Legacy single-token path (migrated into per-account files when present).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailLegacyTokenPath(env = process.env) {
  const override = String(env.GMAIL_INTAKE_TOKEN_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'gmail-intake-token.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function gmailTokensDir(env = process.env) {
  const override = String(env.GMAIL_INTAKE_TOKENS_DIR || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'gmail-intake-tokens');
}

/**
 * Safe filename for an email address.
 * @param {string} email
 */
export function gmailTokenFileSlug(email) {
  return normalizeGmailAddress(email).replace(/[^a-z0-9._+-]+/gi, '_');
}

/**
 * Per-account token path.
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailTokenPathFor(email, env = process.env) {
  const addr = normalizeGmailAddress(email);
  return path.join(gmailTokensDir(env), `${gmailTokenFileSlug(addr)}.json`);
}

/** @deprecated use gmailTokenPathFor / gmailLegacyTokenPath */
export function gmailTokenPath(env = process.env) {
  return gmailLegacyTokenPath(env);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ clientId: string, clientSecret: string } | null}
 */
export function gmailOAuthClient(env = process.env) {
  const clientId = String(
    env.GMAIL_INTAKE_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID || '',
  ).trim();
  const clientSecret = String(
    env.GMAIL_INTAKE_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  ).trim();
  if (!clientId || !clientSecret || clientId.startsWith('REPLACE') || clientSecret.startsWith('REPLACE')) {
    return null;
  }
  return { clientId, clientSecret };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailOAuthRedirectUri(env = process.env) {
  const explicit = String(env.GMAIL_OAUTH_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const origin = String(env.DASHBOARD_LAN_ORIGIN || '').trim().replace(/\/$/, '');
  if (origin) return `${origin}/api/events-finder-gmail/oauth/callback`;
  const port = String(env.HOST_PORT || '8787').trim() || '8787';
  return `http://127.0.0.1:${port}/api/events-finder-gmail/oauth/callback`;
}

/**
 * @typedef {{
 *   access_token?: string,
 *   refresh_token?: string,
 *   expiry_date?: number,
 *   token_type?: string,
 *   scope?: string,
 *   email?: string,
 * }} GmailTokenFile
 */

/**
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<GmailTokenFile | null>}
 */
export async function loadGmailTokenFor(email, env = process.env) {
  const addr = normalizeGmailAddress(email);
  if (!addr) return null;
  try {
    const raw = await readFile(gmailTokenPathFor(addr, env), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return { ...data, email: normalizeGmailAddress(data.email) || addr };
  } catch {
    /* try legacy migrate below */
  }

  // One-time: legacy single file → primary account path
  try {
    const legacyRaw = await readFile(gmailLegacyTokenPath(env), 'utf8');
    const data = JSON.parse(legacyRaw);
    if (!data || typeof data !== 'object') return null;
    const legacyEmail = normalizeGmailAddress(data.email) || gmailIntakeAddress(env);
    if (legacyEmail !== addr) return null;
    const migrated = { ...data, email: legacyEmail };
    await saveGmailTokenFor(migrated, legacyEmail, env);
    return migrated;
  } catch {
    return null;
  }
}

/**
 * @param {GmailTokenFile} token
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveGmailTokenFor(token, email, env = process.env) {
  const addr = normalizeGmailAddress(email || token.email);
  if (!addr) throw new Error('Gmail token save requires email');
  const p = gmailTokenPathFor(addr, env);
  await mkdir(path.dirname(p), { recursive: true });
  const payload = { ...token, email: addr };
  await writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
}

/** @deprecated prefer loadGmailTokenFor */
export async function loadGmailToken(env = process.env) {
  return loadGmailTokenFor(gmailIntakeAddress(env), env);
}

/** @deprecated prefer saveGmailTokenFor */
export async function saveGmailToken(token, env = process.env) {
  const email = normalizeGmailAddress(token?.email) || gmailIntakeAddress(env);
  return saveGmailTokenFor(token, email, env);
}

/**
 * Resolve which configured address an OAuth start should target.
 * @param {string | null | undefined} requested
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveGmailOAuthTarget(requested, env = process.env) {
  const addresses = gmailIntakeAddresses(env);
  const want = normalizeGmailAddress(requested);
  if (want && addresses.includes(want)) return want;
  if (want) return want; // allow connecting an extra mailbox; still saved under its profile email
  return addresses[0];
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ email?: string }} [opts]
 */
export function buildGmailOAuthAuthUrl(env = process.env, opts = {}) {
  const client = gmailOAuthClient(env);
  if (!client) {
    const err = new Error(
      'Gmail OAuth not configured — set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (or GMAIL_INTAKE_*).',
    );
    err.code = 'oauth_not_configured';
    throw err;
  }
  const loginHint = resolveGmailOAuthTarget(opts.email, env);
  const redirectUri = gmailOAuthRedirectUri(env);
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_EVENTS_SCOPE,
    access_type: 'offline',
    // Keep the auth URL minimal — extra prompt/login_hint/include_granted_scopes
    // values often break Google's Testing "Continue" interstitial.
    prompt: 'consent',
    state: loginHint,
  });
  return `${AUTH_URI}?${params}`;
}

/**
 * @param {string} code
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ intendedEmail?: string }} [opts]
 */
export async function exchangeGmailOAuthCode(code, env = process.env, opts = {}) {
  const client = gmailOAuthClient(env);
  if (!client) {
    const err = new Error('Gmail OAuth client not configured');
    err.code = 'oauth_not_configured';
    throw err;
  }
  const redirectUri = gmailOAuthRedirectUri(env);
  const body = new URLSearchParams({
    code: String(code || '').trim(),
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const r = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    const err = new Error(json.error_description || json.error || `token exchange HTTP ${r.status}`);
    err.code = 'oauth_exchange_failed';
    throw err;
  }

  let profileEmail = '';
  try {
    const profile = await gmailGet(json.access_token, '/users/me/profile');
    profileEmail = normalizeGmailAddress(profile?.emailAddress);
  } catch {
    /* fall through */
  }

  const intended = normalizeGmailAddress(opts.intendedEmail);
  const email =
    profileEmail
    || intended
    || gmailIntakeAddress(env);

  /** @type {GmailTokenFile} */
  const token = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type || 'Bearer',
    scope: json.scope || GMAIL_EVENTS_SCOPE,
    expiry_date: Date.now() + Number(json.expires_in || 3600) * 1000,
    email,
  };
  const existing = await loadGmailTokenFor(email, env);
  if (!token.refresh_token && existing?.refresh_token) {
    token.refresh_token = existing.refresh_token;
  }
  await saveGmailTokenFor(token, email, env);
  return {
    ...token,
    intendedEmail: intended || null,
    emailMatched: !intended || intended === email,
  };
}

/**
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ ok: boolean, accessToken?: string, email?: string | null, error?: string, code?: string }>}
 */
export async function getGmailAccessTokenFor(email, env = process.env) {
  const addr = normalizeGmailAddress(email);
  const client = gmailOAuthClient(env);
  if (!client) {
    return {
      ok: false,
      code: 'oauth_not_configured',
      error:
        'Set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (or GMAIL_INTAKE_*) in .env',
    };
  }
  const stored = await loadGmailTokenFor(addr, env);
  if (!stored?.refresh_token && !stored?.access_token) {
    return {
      ok: false,
      code: 'oauth_not_connected',
      error: `Connect ${addr} via Settings → Events sources → Connect Gmail`,
    };
  }

  const skewMs = 60_000;
  if (
    stored.access_token &&
    Number(stored.expiry_date) > Date.now() + skewMs
  ) {
    return { ok: true, accessToken: stored.access_token, email: stored.email || addr };
  }

  if (!stored.refresh_token) {
    return {
      ok: false,
      code: 'oauth_not_connected',
      error: 'Gmail token missing refresh_token — reconnect OAuth',
    };
  }

  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: stored.refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    return {
      ok: false,
      code: 'oauth_refresh_failed',
      error: json.error_description || json.error || `refresh HTTP ${r.status}`,
    };
  }
  const next = {
    ...stored,
    access_token: json.access_token,
    token_type: json.token_type || stored.token_type || 'Bearer',
    scope: json.scope || stored.scope || GMAIL_EVENTS_SCOPE,
    expiry_date: Date.now() + Number(json.expires_in || 3600) * 1000,
    email: stored.email || addr,
  };
  if (json.refresh_token) next.refresh_token = json.refresh_token;
  await saveGmailTokenFor(next, addr, env);
  return { ok: true, accessToken: next.access_token, email: next.email || addr };
}

/** @deprecated prefer getGmailAccessTokenFor */
export async function getGmailAccessToken(env = process.env) {
  return getGmailAccessTokenFor(gmailIntakeAddress(env), env);
}

/**
 * @param {string} s
 */
function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * @param {any} part
 * @param {{ texts: string[], htmls: string[], ics: string[] }} bag
 */
function collectMimeParts(part, bag) {
  if (!part || typeof part !== 'object') return;
  const mime = String(part.mimeType || '').toLowerCase();
  const filename = String(part.filename || '').toLowerCase();
  const data = part.body?.data ? String(part.body.data) : '';

  if (data && (mime === 'text/calendar' || filename.endsWith('.ics'))) {
    bag.ics.push(b64urlDecode(data));
  } else if (data && mime === 'text/plain') {
    bag.texts.push(b64urlDecode(data));
  } else if (data && mime === 'text/html') {
    bag.htmls.push(b64urlDecode(data));
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) collectMimeParts(child, bag);
  }
}

/**
 * @param {string} htmlOrText
 * @returns {string[]}
 */
export function extractPlatformUrls(htmlOrText) {
  const raw = String(htmlOrText || '');
  const found = raw.match(PLATFORM_HOST_RE) || [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (let u of found) {
    u = u.replace(/[.,;:!?)]+$/, '');
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try {
      const parsed = new URL(u);
      // Prefer the real event subdomain inside Secret Party click-trackers.
      const unwrapped = unwrapSecretPartyTrackingUrl(parsed.href);
      const finalUrl = unwrapped || parsed.href;
      const host = new URL(finalUrl).hostname.replace(/^www\./, '').toLowerCase();
      if (host === 'track.secretparty.io') continue;
      const key = finalUrl.split('#')[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finalUrl.split('#')[0]);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Decode Secret Party ESP click trackers → https://<slug>.secretparty.io/...
 * @param {string} href
 * @returns {string | null}
 */
function unwrapSecretPartyTrackingUrl(href) {
  try {
    const u = new URL(href);
    if (u.hostname.replace(/^www\./, '').toLowerCase() !== 'track.secretparty.io') return null;
    const p = u.searchParams.get('p');
    if (!p) return null;
    // Payload is URL-safe base64 JSON: { p: "<stringified json with url>" } or nested.
    const padded = p.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const json = Buffer.from(padded + pad, 'base64').toString('utf8');
    const outer = JSON.parse(json);
    let inner = outer;
    if (typeof outer?.p === 'string') {
      try {
        inner = JSON.parse(outer.p);
      } catch {
        inner = outer;
      }
    }
    const target = String(inner?.url || inner?.u || '').trim();
    if (!target) return null;
    const dest = new URL(target);
    const host = dest.hostname.replace(/^www\./, '').toLowerCase();
    if (!host.endsWith('secretparty.io') || host === 'track.secretparty.io') return null;
    return dest.href.split('#')[0];
  } catch {
    return null;
  }
}

/**
 * Prefer a platform source key when the message links to a known host.
 * @param {string[]} urls
 * @param {string} [fallback='gmail']
 * @returns {string}
 */
export function sourceFromPlatformUrls(urls, fallback = 'gmail') {
  for (const href of urls || []) {
    try {
      const host = new URL(href).hostname.replace(/^www\./, '').toLowerCase();
      if (host === 'secretparty.io' || host.endsWith('.secretparty.io')) return 'secretparty';
      if (host === 'partiful.com' || host.endsWith('.partiful.com')) return 'partiful';
      if (host === 'lu.ma' || host === 'luma.com' || host.endsWith('.luma.com')) return 'luma';
      if (host === 'eventbrite.com' || host.endsWith('.eventbrite.com')) return 'eventbrite';
      if (host === 'meetup.com' || host.endsWith('.meetup.com')) return 'meetup';
      if (host === 'facebook.com' || host.endsWith('.facebook.com')) return 'facebook';
    } catch {
      /* ignore */
    }
  }
  return fallback;
}

/**
 * Human title from Secret Party subdomain slug when the page/subject is generic.
 * @param {string} href
 * @returns {string | null}
 */
export function secretPartyTitleFromUrl(href) {
  try {
    const host = new URL(href).hostname.replace(/^www\./, '').toLowerCase();
    const m = host.match(/^([a-z0-9-]+)\.secretparty\.io$/);
    if (!m || !m[1] || m[1] === 'www' || m[1] === 'api') return null;
    return m[1]
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .slice(0, 180);
  } catch {
    return null;
  }
}

/**
 * Best-effort start ISO from subject/body when no .ics.
 * @param {string} blob
 * @returns {string | null}
 */
function guessStartIso(blob) {
  const text = String(blob || '');
  // ISO-ish
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/);
  if (iso) {
    const t = iso[2] || '12:00';
    const [hhRaw, mmRaw = '00'] = t.split(':');
    const hh = String(Math.min(23, Math.max(0, Number(hhRaw) || 0))).padStart(2, '0');
    const mm = String(Math.min(59, Math.max(0, Number(mmRaw) || 0))).padStart(2, '0');
    const ms = Date.parse(`${iso[1]}T${hh}:${mm}:00`);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  // Month Day, Year
  const mdy = text.match(
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2})(?:\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?/i,
  );
  if (mdy) {
    const ms = Date.parse(mdy[1] + (mdy[2] ? ` ${mdy[2]}` : ''));
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/**
 * @param {string} accessToken
 * @param {string} pathAndQuery
 */
async function gmailGet(accessToken, pathAndQuery) {
  const r = await fetch(`${GMAIL_API}${pathAndQuery}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(json?.error?.message || `Gmail API HTTP ${r.status}`);
    err.code = 'gmail_api_error';
    err.status = r.status;
    throw err;
  }
  return json;
}

/**
 * Header helpers.
 * @param {Array<{ name?: string, value?: string }>} headers
 * @param {string} name
 */
function headerValue(headers, name) {
  const want = name.toLowerCase();
  const h = (headers || []).find((x) => String(x?.name || '').toLowerCase() === want);
  return h ? String(h.value || '').trim() : '';
}

/**
 * Normalize one Gmail message into zero or more Events finder events.
 * @param {any} message
 * @param {string} [defaultTz]
 * @param {{ mailbox?: string }} [opts]
 */
export function eventsFromGmailMessage(message, defaultTz = 'America/Los_Angeles', opts = {}) {
  const id = String(message?.id || '');
  const mailbox = normalizeGmailAddress(opts.mailbox) || '';
  const idPrefix = mailbox ? `gmail:${mailbox}:${id}` : `gmail:${id}`;
  const headers = message?.payload?.headers || [];
  const subject = headerValue(headers, 'Subject') || '(no subject)';
  const from = headerValue(headers, 'From');
  const dateHdr = headerValue(headers, 'Date');
  const threadId = String(message?.threadId || '');

  /** @type {{ texts: string[], htmls: string[], ics: string[] }} */
  const bag = { texts: [], htmls: [], ics: [] };
  collectMimeParts(message?.payload, bag);

  const textBlob = [...bag.texts, ...bag.htmls.map(stripHtml)].join('\n');
  const urls = extractPlatformUrls([...bag.texts, ...bag.htmls].join('\n'));

  /** @type {Array<{
   *   id: string,
   *   title: string,
   *   start: string | null,
   *   end?: string | null,
   *   venue?: string | null,
   *   city?: string | null,
   *   lat?: number | null,
   *   lon?: number | null,
   *   url: string,
   *   source: string,
   *   location?: string | null,
   *   raw: object,
   * }>} */
  const events = [];

  for (let i = 0; i < bag.ics.length; i += 1) {
    const parsed = parseIcsEvents(bag.ics[i], defaultTz);
    for (const ev of parsed) {
      const startIso = Number.isFinite(ev.startMs) ? new Date(ev.startMs).toISOString() : null;
      const endIso = Number.isFinite(ev.endMs) ? new Date(ev.endMs).toISOString() : null;
      const url = urls[0] || `https://mail.google.com/mail/u/0/#inbox/${id}`;
      const platformSource = sourceFromPlatformUrls(urls.length ? urls : [url]);
      const slugTitle = platformSource === 'secretparty' ? secretPartyTitleFromUrl(url) : null;
      events.push({
        id: `${idPrefix}:ics:${ev.id}`,
        title: ev.title || slugTitle || subject,
        start: startIso,
        end: endIso,
        venue: ev.location || null,
        location: ev.location || null,
        city: null,
        url,
        source: platformSource === 'gmail' ? 'gmail' : platformSource,
        raw: {
          messageId: id,
          threadId,
          subject,
          from,
          date: dateHdr,
          mailbox: mailbox || null,
          via: 'ics',
          platform: platformSource,
        },
      });
    }
  }

  if (!events.length) {
    const start = guessStartIso(`${subject}\n${textBlob}`) || null;
    const startOk = start && Number.isFinite(Date.parse(start)) ? start : null;
    // Only emit when we have a platform link or a plausible invite subject.
    const inviteish =
      urls.length > 0
      || /\b(invite|invitation|rsvp|you're invited|you are invited|join us|meetup|event)\b/i.test(
        subject,
      );
    if (inviteish) {
      const url = urls[0] || `https://mail.google.com/mail/u/0/#inbox/${id}`;
      const platformSource = sourceFromPlatformUrls(urls.length ? urls : [url]);
      const slugTitle = platformSource === 'secretparty' ? secretPartyTitleFromUrl(url) : null;
      const cleanedSubject = subject.replace(/^(re|fwd):\s*/i, '').trim() || subject;
      events.push({
        id: idPrefix,
        title: slugTitle && /^secret party$/i.test(cleanedSubject) ? slugTitle : cleanedSubject,
        start: startOk,
        end: null,
        venue: null,
        location: null,
        city: null,
        url,
        source: platformSource === 'gmail' ? 'gmail' : platformSource,
        raw: {
          messageId: id,
          threadId,
          subject,
          from,
          date: dateHdr,
          mailbox: mailbox || null,
          via: urls.length ? 'platform_link' : 'subject_heuristic',
          platform: platformSource,
          urls,
          snippet: String(message?.snippet || '').slice(0, 240),
        },
      });
    }
  }

  return events;
}

/**
 * @param {string} html
 */
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Probe one mailbox.
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function probeGmailMailbox(email, env = process.env) {
  const address = normalizeGmailAddress(email);
  const appPassword = gmailAppPasswordFor(address, env);
  if (appPassword) {
    const { probeGmailMailboxViaImap } = await import('./events-finder-gmail-imap.js');
    return probeGmailMailboxViaImap(address, appPassword, env);
  }
  const auth = await getGmailAccessTokenFor(address, env);
  if (!auth.ok) {
    return {
      ok: false,
      ingestOk: null,
      active: false,
      connected: false,
      value: auth.code === 'oauth_not_configured'
        ? 'OAuth app not configured'
        : 'Gmail not connected',
      output: auth.error || 'Connect Gmail intake OAuth',
      ingestTest:
        auth.code === 'oauth_not_configured'
          ? 'Not wired — set GOOGLE_OAUTH_CLIENT_ID / SECRET in .env'
          : `Not wired — connect ${address} (OAuth or App Password)`,
      email: address,
      messageCount: 0,
    };
  }

  try {
    const q = encodeURIComponent(gmailEventsQuery(env));
    const list = await gmailGet(
      auth.accessToken,
      `/users/me/messages?maxResults=20&q=${q}`,
    );
    const profile = await gmailGet(auth.accessToken, '/users/me/profile');
    const profileEmail = String(profile?.emailAddress || auth.email || address).toLowerCase();
    const count = Array.isArray(list?.messages) ? list.messages.length : 0;
    const resultSize = Number(list?.resultSizeEstimate || count) || count;

    if (profileEmail && profileEmail !== address) {
      return {
        ok: true,
        ingestOk: false,
        active: true,
        connected: true,
        value: `Connected as ${profileEmail} (expected ${address})`,
        output: `Wrong mailbox — re-auth with login_hint ${address}`,
        ingestTest: `Fail — token is ${profileEmail}, want ${address}`,
        email: profileEmail,
        messageCount: count,
      };
    }

    return {
      ok: true,
      ingestOk: true,
      active: true,
      connected: true,
      value: `Connected (${profileEmail}) · API ok`,
      output: `${resultSize} candidate message(s) in query window`,
      ingestTest: `Pass — ${count} recent message(s) matched event query`,
      email: profileEmail,
      messageCount: count,
    };
  } catch (e) {
    return {
      ok: false,
      ingestOk: false,
      active: false,
      connected: true,
      value: 'Gmail API error',
      output: String(e?.message || e).slice(0, 120),
      ingestTest: `Fail — ${String(e?.message || e).slice(0, 100)}`,
      email: address,
      messageCount: 0,
    };
  }
}

/**
 * Probe all configured intake mailboxes (aggregate for Settings).
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function probeGmailEventsIntake(env = process.env) {
  const addresses = gmailIntakeAddresses(env);
  const accounts = [];
  for (const addr of addresses) {
    accounts.push(await probeGmailMailbox(addr, env));
  }

  const connected = accounts.filter((a) => a.connected);
  const passing = accounts.filter((a) => a.ingestOk === true);
  const anyConfigured = accounts.some((a) => a.value !== 'OAuth app not configured');

  if (!anyConfigured || accounts.every((a) => a.value === 'OAuth app not configured')) {
    return {
      ok: false,
      ingestOk: null,
      active: false,
      value: 'OAuth app not configured',
      output: accounts[0]?.output || 'Connect Gmail intake OAuth',
      ingestTest: 'Not wired — set GOOGLE_OAUTH_CLIENT_ID / SECRET in .env',
      email: addresses.join(', '),
      emails: addresses,
      accounts,
      messageCount: 0,
    };
  }

  if (!connected.length) {
    return {
      ok: false,
      ingestOk: null,
      active: false,
      value: 'Gmail not connected',
      output: `Connect ${addresses.join(' + ')} via Settings → Events sources`,
      ingestTest: `Not wired — connect ${addresses.join(' / ')} (OAuth)`,
      email: addresses.join(', '),
      emails: addresses,
      accounts,
      messageCount: 0,
    };
  }

  const msgTotal = accounts.reduce((n, a) => n + (a.messageCount || 0), 0);
  const labels = accounts.map((a) => {
    if (a.ingestOk) return `${a.email} ✓`;
    if (a.connected) return `${a.email} !`;
    return `${a.email} ✗`;
  });

  if (passing.length === addresses.length) {
    return {
      ok: true,
      ingestOk: true,
      active: true,
      value: `Connected (${passing.length}/${addresses.length}) · API ok`,
      output: accounts.map((a) => a.output).join(' · '),
      ingestTest: `Pass — ${msgTotal} recent message(s) across ${passing.length} inbox(es)`,
      email: passing.map((a) => a.email).join(', '),
      emails: addresses,
      accounts,
      messageCount: msgTotal,
    };
  }

  if (passing.length > 0) {
    return {
      ok: true,
      ingestOk: true,
      active: true,
      value: `Partial (${passing.length}/${addresses.length}): ${labels.join(', ')}`,
      output: accounts.map((a) => `${a.email}: ${a.output}`).join(' · '),
      ingestTest: `Partial — ${passing.length}/${addresses.length} inbox(es) ok · ${msgTotal} message(s)`,
      email: passing.map((a) => a.email).join(', '),
      emails: addresses,
      accounts,
      messageCount: msgTotal,
    };
  }

  const firstFail = connected[0] || accounts[0];
  return {
    ok: false,
    ingestOk: false,
    active: Boolean(connected.length),
    value: firstFail?.value || 'Gmail API error',
    output: accounts.map((a) => `${a.email}: ${a.output}`).join(' · '),
    ingestTest: firstFail?.ingestTest || 'Fail — no inbox passed',
    email: addresses.join(', '),
    emails: addresses,
    accounts,
    messageCount: msgTotal,
  };
}

/**
 * Fetch + parse one mailbox.
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ maxMessages?: number }} [opts]
 */
export async function fetchGmailEventAnnouncementsFor(email, env = process.env, opts = {}) {
  const maxMessages = Math.min(Math.max(Number(opts.maxMessages) || 25, 1), 50);
  const address = normalizeGmailAddress(email);
  const appPassword = gmailAppPasswordFor(address, env);
  if (appPassword) {
    try {
      const { fetchGmailEventsViaImap } = await import('./events-finder-gmail-imap.js');
      return await fetchGmailEventsViaImap(address, appPassword, env, {
        maxMessages,
        windowDays: opts.windowDays,
        scrape: opts.scrape,
        windowWeeks: opts.windowWeeks,
      });
    } catch (e) {
      return {
        ok: false,
        error: e?.code || 'gmail_imap',
        hint: String(e?.message || e),
        email: address,
        scanned: 0,
        events: [],
      };
    }
  }
  const auth = await getGmailAccessTokenFor(address, env);
  if (!auth.ok) {
    return {
      ok: false,
      error: auth.code || 'gmail_auth',
      hint: auth.error,
      email: address,
      scanned: 0,
      events: [],
    };
  }

  try {
    const q = encodeURIComponent(gmailEventsQuery(env));
    const list = await gmailGet(
      auth.accessToken,
      `/users/me/messages?maxResults=${maxMessages}&q=${q}`,
    );
    const ids = (list?.messages || []).map((m) => m.id).filter(Boolean);
    const profile = await gmailGet(auth.accessToken, '/users/me/profile');
    const mailbox = String(profile?.emailAddress || auth.email || address).toLowerCase();

    /** @type {Awaited<ReturnType<typeof eventsFromGmailMessage>>} */
    const events = [];
    for (const mid of ids) {
      const msg = await gmailGet(
        auth.accessToken,
        `/users/me/messages/${encodeURIComponent(mid)}?format=full`,
      );
      events.push(...eventsFromGmailMessage(msg, 'America/Los_Angeles', { mailbox }));
    }

    const windowDays =
      opts.windowDays
      || eventsIngestWindowDays(env, {
        scrape: opts.scrape,
        windowWeeks: opts.windowWeeks,
      });
    const filtered = filterEventsToIngestWindow(events, {
      pastDays: windowDays.pastDays,
      futureDays: windowDays.futureDays,
    });

    return {
      ok: true,
      email: mailbox,
      query: gmailEventsQuery(env),
      scanned: ids.length,
      events: filtered,
      windowDays,
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.code || 'gmail_fetch',
      hint: String(e?.message || e),
      email: address,
      scanned: 0,
      events: [],
    };
  }
}

/**
 * Fetch + parse event announcements from all configured intake inboxes.
 * Horizon follows Scrape ahead (criteria.scrape.windowWeeks) unless opts override.
 * Disk cache + single-flight avoid ~10–20s IMAP on every Events sidebar load.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   maxMessages?: number,
 *   forceRefresh?: boolean,
 *   scrape?: { windowWeeks?: number } | null,
 *   windowWeeks?: number,
 *   windowDays?: { pastDays: number, futureDays: number, windowWeeks?: number },
 * }} [opts]
 */
export async function fetchGmailEventAnnouncements(env = process.env, opts = {}) {
  let scrape = opts.scrape;
  if (!opts.windowDays && scrape == null && opts.windowWeeks == null) {
    try {
      const criteria = await loadEventsFinderCriteria();
      scrape = criteria?.scrape || null;
    } catch {
      scrape = null;
    }
  }
  const windowDays =
    opts.windowDays || eventsIngestWindowDays(env, { scrape, windowWeeks: opts.windowWeeks });
  const fetchOpts = { ...opts, scrape, windowDays };
  const force = opts.forceRefresh === true;

  const addresses = gmailIntakeAddresses(env);
  const query = gmailEventsQuery(env);
  const fingerprint = gmailCacheFingerprint(addresses, query, windowDays);

  if (!force) {
    const cache = await readGmailEventsCache(env);
    if (gmailCacheFresh(cache, fingerprint, env)) {
      return {
        ...cache,
        ok: true,
        fromCache: true,
        stale: false,
        cachedAt: cache.cachedAt || null,
        events: Array.isArray(cache.events) ? cache.events : [],
        windowDays: cache.windowDays || windowDays,
      };
    }
  }

  if (!force && gmailEventsInflight) {
    return gmailEventsInflight;
  }

  const run = (async () => {
    const results = await Promise.all(
      addresses.map((addr) => fetchGmailEventAnnouncementsFor(addr, env, fetchOpts)),
    );

    /** @type {Awaited<ReturnType<typeof eventsFromGmailMessage>>} */
    const events = [];
    /** @type {string[]} */
    const emailsOk = [];
    /** @type {string[]} */
    const hints = [];
    let scanned = 0;
    let anyOk = false;

    for (const r of results) {
      scanned += r.scanned || 0;
      if (r.ok) {
        anyOk = true;
        if (r.email) emailsOk.push(r.email);
        events.push(...(r.events || []));
      } else if (r.hint) {
        hints.push(`${r.email}: ${r.hint}`);
      }
    }

    // Dedupe by platform URL when present, else by id
    const seen = new Set();
    /** @type {typeof events} */
    const deduped = [];
    for (const ev of events) {
      const urlKey = ev.url && !ev.url.includes('mail.google.com')
        ? `url:${String(ev.url).split('#')[0].toLowerCase()}`
        : `id:${ev.id}`;
      if (seen.has(urlKey)) continue;
      seen.add(urlKey);
      deduped.push(ev);
    }

    deduped.sort((a, b) => {
      const am = a.start ? Date.parse(a.start) : Number.POSITIVE_INFINITY;
      const bm = b.start ? Date.parse(b.start) : Number.POSITIVE_INFINITY;
      return am - bm;
    });

    if (!anyOk) {
      const failed = {
        ok: false,
        fromCache: false,
        stale: false,
        cachedAt: null,
        error: results[0]?.error || 'gmail_auth',
        hint: hints.join(' · ') || results[0]?.hint || 'Connect Gmail intake',
        email: addresses.join(', '),
        emails: addresses,
        accounts: results.map((r) => ({
          email: r.email,
          ok: r.ok,
          error: r.error || null,
          hint: r.hint || null,
          scanned: r.scanned || 0,
          count: Array.isArray(r.events) ? r.events.length : 0,
        })),
        scanned,
        events: [],
        windowDays,
      };
      // Prefer stale cache over empty failure (sidebar still paints prior intake).
      const stale = await readGmailEventsCache(env);
      if (stale && Array.isArray(stale.events) && stale.events.length) {
        return {
          ...stale,
          ok: true,
          fromCache: true,
          stale: true,
          error: failed.error,
          hint: failed.hint || 'Using stale Gmail cache',
          events: stale.events,
          windowDays: stale.windowDays || windowDays,
        };
      }
      return failed;
    }

    const payload = {
      ok: true,
      fromCache: false,
      stale: false,
      cachedAt: new Date().toISOString(),
      fingerprint,
      email: emailsOk.join(', '),
      emails: emailsOk,
      accounts: results.map((r) => ({
        email: r.email,
        ok: r.ok,
        error: r.error || null,
        hint: r.hint || null,
        scanned: r.scanned || 0,
        count: Array.isArray(r.events) ? r.events.length : 0,
      })),
      query,
      scanned,
      events: deduped,
      windowDays,
      hint: hints.length ? hints.join(' · ') : null,
      error: null,
    };
    try {
      await writeGmailEventsCache(payload, env);
    } catch (e) {
      console.warn('[events-finder] gmail cache write failed:', e?.message || e);
    }
    return payload;
  })();

  gmailEventsInflight = run;
  run.finally(() => {
    if (gmailEventsInflight === run) gmailEventsInflight = null;
  });
  return run;
}

/**
 * Config snapshot for Settings / API (no secrets).
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function gmailIntakeStatusSummary(env = process.env) {
  const client = gmailOAuthClient(env);
  const addresses = gmailIntakeAddresses(env);
  const accounts = [];
  for (const email of addresses) {
    const token = await loadGmailTokenFor(email, env);
    const appPassword = Boolean(gmailAppPasswordFor(email, env));
    accounts.push({
      email,
      tokenOnDisk: Boolean(token?.refresh_token || token?.access_token),
      appPasswordConfigured: appPassword,
      oauthStartPath: `/api/events-finder-gmail/oauth/start?email=${encodeURIComponent(email)}`,
    });
  }
  return {
    address: addresses[0],
    addresses,
    accounts,
    oauthConfigured: Boolean(client),
    tokenOnDisk: accounts.some((a) => a.tokenOnDisk),
    appPasswordConfigured: accounts.some((a) => a.appPasswordConfigured),
    redirectUri: gmailOAuthRedirectUri(env),
    query: gmailEventsQuery(env),
  };
}

/**
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function gmailTokenExists(email, env = process.env) {
  try {
    await access(gmailTokenPathFor(email, env));
    return true;
  } catch {
    return false;
  }
}

/**
 * Find emails across Gmail intake mailboxes that involve this person
 * (from/to/cc their email, or their name in the message).
 *
 * @param {{
 *   email?: string | null,
 *   displayName?: string | null,
 *   aliases?: string[],
 * }} contact
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ maxMessages?: number }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   detail?: string,
 *   query?: string,
 *   messages?: Array<{
 *     id: string,
 *     mailbox: string,
 *     subject: string,
 *     from: string,
 *     to: string,
 *     date: string,
 *     snippet: string,
 *     text: string,
 *   }>,
 *   combinedText?: string,
 * }>}
 */
export async function fetchSharedEmailsWithContact(contact, env = process.env, opts = {}) {
  const maxMessages = Math.min(Math.max(Number(opts.maxMessages) || 12, 1), 25);
  const email = normalizeGmailAddress(contact?.email || '');
  const name = String(contact?.displayName || '').trim();
  const nickname = String(contact?.nickname || '').trim();
  const aliases = Array.isArray(contact?.aliases)
    ? contact.aliases.map((a) => String(a || '').trim()).filter(Boolean)
    : [];

  /** @type {string[]} */
  const clauses = [];
  if (email) {
    clauses.push(`from:${email}`, `to:${email}`, `cc:${email}`);
  }
  for (const n of [name, nickname, ...aliases].filter(Boolean).slice(0, 5)) {
    const q = /\s/.test(n) ? `"${n.replace(/"/g, '')}"` : n.replace(/"/g, '');
    if (q) clauses.push(q);
  }
  if (!clauses.length) {
    return { ok: false, error: 'no_email_or_name' };
  }
  const query = `(${[...new Set(clauses)].join(' OR ')})`;

  const mailboxes = gmailIntakeAddresses(env);
  /** @type {Array<{ id: string, mailbox: string, subject: string, from: string, to: string, date: string, snippet: string, text: string }>} */
  const messages = [];
  /** @type {string[]} */
  const errors = [];

  for (const mailbox of mailboxes) {
    let accessToken;
    try {
      accessToken = await getGmailAccessTokenFor(mailbox, env);
    } catch (e) {
      errors.push(`${mailbox}: ${e?.message || e}`);
      continue;
    }
    if (!accessToken) {
      errors.push(`${mailbox}: not_connected`);
      continue;
    }

    try {
      const list = await gmailGet(
        accessToken,
        `/users/me/messages?maxResults=${maxMessages}&q=${encodeURIComponent(query)}`,
      );
      const ids = Array.isArray(list?.messages) ? list.messages.map((m) => String(m.id || '')).filter(Boolean) : [];
      for (const id of ids.slice(0, maxMessages)) {
        if (messages.some((m) => m.id === id && m.mailbox === mailbox)) continue;
        const full = await gmailGet(accessToken, `/users/me/messages/${encodeURIComponent(id)}?format=full`);
        const headers = full?.payload?.headers || [];
        const subject = headerValue(headers, 'Subject') || '(no subject)';
        const from = headerValue(headers, 'From');
        const to = headerValue(headers, 'To');
        const date = headerValue(headers, 'Date');
        /** @type {{ texts: string[], htmls: string[], ics: string[] }} */
        const bag = { texts: [], htmls: [], ics: [] };
        collectMimeParts(full?.payload, bag);
        const text = [...bag.texts, ...bag.htmls.map(stripHtml)]
          .join('\n')
          .replace(/\s+\n/g, '\n')
          .trim()
          .slice(0, 8_000);
        messages.push({
          id,
          mailbox,
          subject,
          from,
          to,
          date,
          snippet: String(full?.snippet || '').trim().slice(0, 280),
          text: text || String(full?.snippet || '').trim(),
        });
        if (messages.length >= maxMessages) break;
      }
    } catch (e) {
      errors.push(`${mailbox}: ${e?.message || e}`);
    }
    if (messages.length >= maxMessages) break;
  }

  if (!messages.length) {
    return {
      ok: false,
      error: errors.length ? 'gmail_search_failed' : 'no_shared_emails',
      detail: errors.slice(0, 4).join('; ') || undefined,
    };
  }

  messages.sort((a, b) => (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0));

  const combinedText = messages
    .map(
      (m) =>
        `Email (${m.mailbox})\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.text || m.snippet}`,
    )
    .join('\n\n==========\n\n')
    .slice(0, 28_000);

  return {
    ok: true,
    query,
    messages: messages.map((m) => ({ ...m, text: String(m.text || '').slice(0, 500) })),
    combinedText,
  };
}
