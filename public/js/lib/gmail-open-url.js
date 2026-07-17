/**
 * Gmail web + native app deep links for Daily Summary "Open".
 *
 * Hex API ids in `#all/{id}` are unreliable on a cold browser load (often inbox only).
 * Prefer rfc822msgid search, then `#inbox/{threadId}`, then `#all/` as last resort.
 */

/**
 * @param {{
 *   email?: string,
 *   threadId?: string,
 *   gmailId?: string,
 *   messageId?: string,
 *   rfc822MessageId?: string,
 *   subject?: string,
 * } | null | undefined} source
 */
export function gmailWebMessageUrl(source) {
  if (!source?.email) return '';
  const email = encodeURIComponent(String(source.email).trim().toLowerCase());
  const base = `https://mail.google.com/mail/u/?authuser=${email}`;

  const rfc = String(source.rfc822MessageId || '')
    .trim()
    .replace(/^<|>$/g, '');
  if (rfc) {
    return `${base}#search/${encodeURIComponent(`rfc822msgid:${rfc}`)}`;
  }

  const threadId = String(source.threadId || '').trim();
  if (threadId && /^[0-9a-f]+$/i.test(threadId) && !/^\d+$/.test(threadId)) {
    return `${base}#inbox/${threadId.toLowerCase()}`;
  }

  const gmailId = String(source.gmailId || '').trim().toLowerCase();
  if (gmailId && /^[0-9a-f]+$/.test(gmailId) && !/^\d+$/.test(gmailId)) {
    return `${base}#all/${gmailId}`;
  }

  const apiId = String(source.messageId || '').trim();
  if (apiId && /^[0-9a-f]+$/i.test(apiId) && !/^\d+$/.test(apiId)) {
    return `${base}#all/${apiId.toLowerCase()}`;
  }

  const subject = String(source.subject || '').trim();
  if (subject) {
    return `${base}#search/${encodeURIComponent(`subject:${subject}`)}`;
  }
  if (apiId) {
    return `${base}#search/${encodeURIComponent(apiId)}`;
  }
  return '';
}

/**
 * @param {{
 *   threadId?: string,
 *   gmailId?: string,
 *   messageId?: string,
 *   rfc822MessageId?: string,
 *   subject?: string,
 * } | null | undefined} source
 * @returns {string}
 */
function gmailNativeAppUrl(source) {
  const threadId = String(source?.threadId || '').trim();
  if (threadId) {
    return `googlegmail:///cv?th=${encodeURIComponent(threadId)}`;
  }
  const rfc = String(source?.rfc822MessageId || '')
    .trim()
    .replace(/^<|>$/g, '');
  if (rfc) {
    return `googlegmail:///search?q=${encodeURIComponent(`rfc822msgid:${rfc}`)}`;
  }
  const msgId = String(source?.gmailId || source?.messageId || '').trim();
  if (msgId && /^[0-9a-f]+$/i.test(msgId) && !/^\d+$/.test(msgId)) {
    return `googlegmail:///cv?id=${encodeURIComponent(msgId.toLowerCase())}`;
  }
  const subject = String(source?.subject || '').trim();
  if (subject) {
    return `googlegmail:///search?q=${encodeURIComponent(`subject:${subject}`)}`;
  }
  return '';
}

/**
 * @param {string} webUrl
 * @returns {string}
 */
function gmailNativeAppUrlFromWebSearch(webUrl) {
  const url = String(webUrl || '').trim();
  const hashIdx = url.indexOf('#');
  if (hashIdx < 0) return '';
  const hash = url.slice(hashIdx + 1);
  if (!hash.startsWith('search/')) return '';
  let q = hash.slice('search/'.length);
  try {
    q = decodeURIComponent(q);
  } catch {
    /* keep encoded */
  }
  if (!q) return '';
  return `googlegmail:///search?q=${encodeURIComponent(q)}`;
}

/**
 * Resolve a Gmail web deep link for mobile native app handoff when possible.
 * Desktop callers should keep the original https://mail.google.com URL.
 *
 * @param {string} webUrl
 * @param {{
 *   threadId?: string,
 *   gmailId?: string,
 *   messageId?: string,
 *   rfc822MessageId?: string,
 *   subject?: string,
 * } | null | undefined} [source]
 */
export function gmailMobileOpenUrl(webUrl, source = null) {
  const url = String(webUrl || '').trim();
  const native =
    gmailNativeAppUrl(source)
    || gmailNativeAppUrlFromWebSearch(url);
  if (native) return native;

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isAndroid = /Android/i.test(ua);

  if (isAndroid) {
    // Intent URLs use `#Intent;` — a web hash like `#all/…` is stripped and lands on inbox.
    if (url.includes('#')) return url;
    const path = url.replace(/^https:\/\//i, '');
    return (
      `intent://${path}#Intent;scheme=https;action=android.intent.action.VIEW;`
      + 'category=android.intent.category.BROWSABLE;package=com.google.android.gm;'
      + `S.browser_fallback_url=${encodeURIComponent(url)};end`
    );
  }

  return url;
}

/** @returns {boolean} */
export function isMobileGmailClient() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Android|iPhone|iPad|iPod/i.test(ua);
}
