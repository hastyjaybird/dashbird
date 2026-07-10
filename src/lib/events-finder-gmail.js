/**
 * Events finder — Gmail intake (multi-account).
 * Default inboxes: jay.intake.box@gmail.com + julia.hasty@gmail.com.
 * OAuth2 refresh tokens on disk; Gmail API list + parse (.ics / RSVP links / heuristics).
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIcsEvents } from './ical-parse.js';

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

const DEFAULT_QUERY =
  'newer_than:45d (filename:ics OR subject:(invite OR invitation OR RSVP OR event OR meetup OR "you\'re invited" OR "join us") OR from:(partiful.com OR secretparty.io OR lu.ma OR eventbrite.com OR meetup.com OR facebookmail.com OR metamail.com OR facebook.com))';

/**
 * Public event / invite links. Facebook: /events/{id}, page hosted tabs, group events.
 */
const PLATFORM_HOST_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:partiful\.com|secretparty\.io|lu\.ma|luma\.com|eventbrite\.com|meetup\.com|facebook\.com\/(?:events\/[^\s"'<>)\]]+|[^/\s"'<>)\]]+\/(?:upcoming_hosted_events|past_hosted_events|events)|groups\/[^/\s"'<>)\]]+\/events)[^\s"'<>)\]]*)/gi;

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
function extractPlatformUrls(htmlOrText) {
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
      const key = parsed.href.split('#')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(parsed.href);
    } catch {
      /* ignore */
    }
  }
  return out;
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
      events.push({
        id: `${idPrefix}:ics:${ev.id}`,
        title: ev.title || subject,
        start: startIso,
        end: endIso,
        venue: ev.location || null,
        location: ev.location || null,
        city: null,
        url: urls[0] || `https://mail.google.com/mail/u/0/#inbox/${id}`,
        source: 'gmail',
        raw: {
          messageId: id,
          threadId,
          subject,
          from,
          date: dateHdr,
          mailbox: mailbox || null,
          via: 'ics',
        },
      });
    }
  }

  if (!events.length) {
    const start = guessStartIso(`${subject}\n${textBlob}`) || (dateHdr ? new Date(dateHdr).toISOString() : null);
    const startOk = start && Number.isFinite(Date.parse(start)) ? start : null;
    // Only emit when we have a platform link or a plausible invite subject.
    const inviteish =
      urls.length > 0
      || /\b(invite|invitation|rsvp|you're invited|you are invited|join us|meetup|event)\b/i.test(
        subject,
      );
    if (inviteish) {
      events.push({
        id: idPrefix,
        title: subject.replace(/^(re|fwd):\s*/i, '').trim() || subject,
        start: startOk,
        end: null,
        venue: null,
        location: null,
        city: null,
        url: urls[0] || `https://mail.google.com/mail/u/0/#inbox/${id}`,
        source: 'gmail',
        raw: {
          messageId: id,
          threadId,
          subject,
          from,
          date: dateHdr,
          mailbox: mailbox || null,
          via: urls.length ? 'platform_link' : 'subject_heuristic',
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
          : `Not wired — connect ${address} (OAuth)`,
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

    const now = Date.now();
    const windowPastMs = 2 * 24 * 60 * 60 * 1000;
    const filtered = events.filter((ev) => {
      if (!ev.start) return true;
      const ms = Date.parse(ev.start);
      if (!Number.isFinite(ms)) return true;
      return ms >= now - windowPastMs;
    });

    return {
      ok: true,
      email: mailbox,
      query: gmailEventsQuery(env),
      scanned: ids.length,
      events: filtered,
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
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ maxMessages?: number }} [opts]
 */
export async function fetchGmailEventAnnouncements(env = process.env, opts = {}) {
  const addresses = gmailIntakeAddresses(env);
  const results = await Promise.all(
    addresses.map((addr) => fetchGmailEventAnnouncementsFor(addr, env, opts)),
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
    return {
      ok: false,
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
    };
  }

  return {
    ok: true,
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
    query: gmailEventsQuery(env),
    scanned,
    events: deduped,
    hint: hints.length ? hints.join(' · ') : null,
  };
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
    accounts.push({
      email,
      tokenOnDisk: Boolean(token?.refresh_token || token?.access_token),
      oauthStartPath: `/api/events-finder-gmail/oauth/start?email=${encodeURIComponent(email)}`,
    });
  }
  return {
    address: addresses[0],
    addresses,
    accounts,
    oauthConfigured: Boolean(client),
    tokenOnDisk: accounts.some((a) => a.tokenOnDisk),
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
