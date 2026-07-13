/**
 * Gmail intake via IMAP + App Password (bypasses broken OAuth consent UI).
 */
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import {
  eventsFromGmailMessage,
  gmailEventsQuery,
  normalizeGmailAddress,
} from './events-finder-gmail.js';
import {
  eventsIngestWindowDays,
  filterEventsToIngestWindow,
} from './events-finder-window.js';

/**
 * @param {string} s
 */
function b64urlEncode(s) {
  return Buffer.from(String(s || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * @param {any} addrList
 */
function formatAddressList(addrList) {
  if (!Array.isArray(addrList) || !addrList.length) return '';
  return addrList
    .map((a) => {
      const email = a?.address || a?.email || '';
      const name = a?.name || '';
      if (name && email) return `${name} <${email}>`;
      return email || name || '';
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * Build a Gmail-API-shaped message so eventsFromGmailMessage can reuse parse logic.
 * @param {{ uid: number|string, parsed: any, envelope?: any }} opts
 */
function toGmailMessageShape({ uid, parsed, envelope }) {
  const subject = parsed?.subject || envelope?.subject || '(no subject)';
  const from = formatAddressList(parsed?.from)
    || formatAddressList(envelope?.from)
    || '';
  const dateVal = parsed?.date
    || (envelope?.date ? new Date(envelope.date).toUTCString() : '');
  const headers = [
    { name: 'Subject', value: String(subject) },
    { name: 'From', value: String(from) },
    { name: 'Date', value: String(dateVal || '') },
  ];
  /** @type {any[]} */
  const parts = [];
  if (parsed?.text) {
    parts.push({ mimeType: 'text/plain', body: { data: b64urlEncode(parsed.text) } });
  }
  if (parsed?.html) {
    parts.push({ mimeType: 'text/html', body: { data: b64urlEncode(parsed.html) } });
  }
  for (const att of parsed?.attachments || []) {
    const filename = String(att.filename || att.contentDisposition?.filename || 'attach');
    const mime = String(att.mimeType || att.contentType || 'application/octet-stream').toLowerCase();
    const isIcs = mime.includes('calendar') || /\.ics$/i.test(filename);
    if (!isIcs) continue;
    const buf = Buffer.isBuffer(att.content)
      ? att.content
      : Buffer.from(att.content || '');
    parts.push({
      mimeType: 'text/calendar',
      filename,
      body: {
        data: buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      },
    });
  }
  const snippet = String(parsed?.text || parsed?.html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return {
    id: String(uid),
    threadId: String(uid),
    snippet,
    payload: {
      mimeType: parts.length > 1 ? 'multipart/mixed' : (parts[0]?.mimeType || 'text/plain'),
      headers,
      parts: parts.length ? parts : undefined,
      body: parts.length === 1 ? parts[0].body : undefined,
    },
  };
}

/**
 * @param {string} email
 * @param {string} appPassword
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ maxMessages?: number }} [opts]
 */
export async function fetchGmailEventsViaImap(email, appPassword, env = process.env, opts = {}) {
  const address = normalizeGmailAddress(email);
  const maxMessages = Math.min(Math.max(Number(opts.maxMessages) || 50, 1), 100);
  const query = gmailEventsQuery(env);
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: address, pass: appPassword },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    /** @type {number[]} */
    let uids = [];
    try {
      uids = await client.search({ gmraw: query }, { uid: true });
    } catch {
      // Fallback if X-GM-RAW unavailable
      const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      uids = await client.search({ since }, { uid: true });
    }
    if (!Array.isArray(uids)) uids = [];
    const slice = uids.slice(-maxMessages);

    /** @type {ReturnType<typeof eventsFromGmailMessage>} */
    const events = [];
    for (const uid of slice) {
      const downloaded = await client.download(uid, undefined, { uid: true });
      const chunks = [];
      for await (const chunk of downloaded.content) chunks.push(chunk);
      const source = Buffer.concat(chunks);
      const parsed = await PostalMime.parse(source);
      const shaped = toGmailMessageShape({
        uid,
        parsed,
        envelope: null,
      });
      events.push(...eventsFromGmailMessage(shaped, 'America/Los_Angeles', { mailbox: address }));
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
      email: address,
      via: 'imap',
      query,
      scanned: slice.length,
      events: filtered,
      windowDays,
    };
  } finally {
    try {
      lock.release();
    } catch {
      /* ignore */
    }
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} email
 * @param {string} appPassword
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function probeGmailMailboxViaImap(email, appPassword, env = process.env) {
  const address = normalizeGmailAddress(email);
  try {
    const result = await fetchGmailEventsViaImap(address, appPassword, env, { maxMessages: 40 });
    const count = result.scanned || 0;
    return {
      ok: true,
      ingestOk: true,
      active: true,
      connected: true,
      value: `Connected (${address}) · IMAP ok`,
      output: `${count} candidate message(s) in query window`,
      ingestTest: `Pass — ${count} recent message(s) matched event query (IMAP)`,
      email: address,
      messageCount: count,
      via: 'imap',
    };
  } catch (e) {
    return {
      ok: false,
      ingestOk: false,
      active: false,
      connected: false,
      value: 'IMAP auth failed',
      output: String(e?.message || e).slice(0, 160),
      ingestTest: `Fail — ${String(e?.message || e).slice(0, 100)}`,
      email: address,
      messageCount: 0,
      via: 'imap',
    };
  }
}
