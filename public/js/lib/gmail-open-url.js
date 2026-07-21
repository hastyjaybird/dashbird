/**
 * Gmail web + native app deep links for Daily Summary "Open".
 *
 * A bare `mail.google.com/mail/u/?authuser=…#…` link loses its #fragment when
 * Google bounces through account selection (script redirect), stranding the
 * click on the inbox. Routing through accounts.google.com/AccountChooser with
 * the full target (fragment percent-encoded) inside `continue` survives that
 * bounce, so the deep link reaches the Gmail UI intact.
 *
 * Prefer the thread view (`#all/{threadId}`) so the email itself opens, then
 * rfc822msgid search, then hex `#all/` ids — IMAP decimal UIDs never work.
 */

/** @param {unknown} value */
function hexId(value) {
  const v = String(value || '').trim();
  return /^[0-9a-f]+$/i.test(v) && !/^\d+$/.test(v) ? v.toLowerCase() : '';
}

/**
 * @param {{
 *   threadId?: string,
 *   gmailId?: string,
 *   messageId?: string,
 *   rfc822MessageId?: string,
 *   subject?: string,
 * } | null | undefined} source
 * @returns {string} Gmail UI hash (without leading '#'), or ''.
 */
function gmailTargetHash(source) {
  const threadId = hexId(source?.threadId);
  if (threadId) return `all/${threadId}`;

  const rfc = String(source?.rfc822MessageId || '')
    .trim()
    .replace(/^<|>$/g, '');
  if (rfc) return `search/${encodeURIComponent(`rfc822msgid:${rfc}`)}`;

  const gmailId = hexId(source?.gmailId);
  if (gmailId) return `all/${gmailId}`;

  const apiId = hexId(source?.messageId);
  if (apiId) return `all/${apiId}`;

  const subject = String(source?.subject || '').trim();
  if (subject) return `search/${encodeURIComponent(`subject:${subject}`)}`;

  const rawId = String(source?.messageId || '').trim();
  if (rawId) return `search/${encodeURIComponent(rawId)}`;
  return '';
}

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
  const email = String(source.email).trim().toLowerCase();
  const hash = gmailTargetHash(source);
  if (!hash) return '';
  const target = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#${hash}`;
  return (
    'https://accounts.google.com/AccountChooser'
    + `?Email=${encodeURIComponent(email)}`
    + `&continue=${encodeURIComponent(target)}`
  );
}

/**
 * iOS Gmail app deep link (the googlegmail:// scheme is iOS-only).
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
  // IMAP decimal UIDs are not routable thread ids — hex only.
  const threadId = hexId(source?.threadId);
  if (threadId) {
    return `googlegmail:///cv?th=${encodeURIComponent(threadId)}`;
  }
  const rfc = String(source?.rfc822MessageId || '')
    .trim()
    .replace(/^<|>$/g, '');
  if (rfc) {
    return `googlegmail:///search?q=${encodeURIComponent(`rfc822msgid:${rfc}`)}`;
  }
  const msgId = hexId(source?.gmailId) || hexId(source?.messageId);
  if (msgId) {
    return `googlegmail:///cv?id=${encodeURIComponent(msgId)}`;
  }
  const subject = String(source?.subject || '').trim();
  if (subject) {
    return `googlegmail:///search?q=${encodeURIComponent(`subject:${subject}`)}`;
  }
  return '';
}

/**
 * Resolve the best "Open" href for mobile.
 *
 * iOS: hand off to the Gmail app via its googlegmail:// scheme when possible.
 * Android: the googlegmail:// scheme is not supported and intent:// wrappers
 * break the AccountChooser hop, so use the web URL as-is.
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
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPhone|iPad|iPod/i.test(ua)) {
    const native = gmailNativeAppUrl(source);
    if (native) return native;
  }
  return url;
}

/** @returns {boolean} */
export function isMobileGmailClient() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Android|iPhone|iPad|iPod/i.test(ua);
}
