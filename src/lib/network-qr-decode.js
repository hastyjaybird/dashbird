/**
 * Decode QR payloads from business-card / contact photos.
 * Uses sharp for pixel prep + jsqr for decoding (VLMs often cannot read QR bits).
 */

const MAX_EDGE = 1800;
const MIN_EDGE = 320;

/**
 * @param {string} raw
 * @returns {string | null}
 */
function normalizeHttpUrl(raw) {
  const s = String(raw || '').trim().replace(/[),.\]}>'"]+$/g, '');
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!u.hostname) return null;
      return u.toString();
    } catch {
      return null;
    }
  }
  // Bare domains / paths common on cards ("acme.com", "www.acme.com/team")
  if (/^(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(s) && !/\s/.test(s)) {
    try {
      return new URL(`https://${s}`).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {string} host
 */
function isTelegramHost(host) {
  const h = String(host || '').replace(/^www\./i, '').toLowerCase();
  return (
    h === 't.me'
    || h.endsWith('.t.me')
    || h === 'telegram.me'
    || h.endsWith('.telegram.me')
    || h === 'telegram.org'
    || h.endsWith('.telegram.org')
    || h === 'telegram.dog'
    || h.endsWith('.telegram.dog')
    || h === 'web.telegram.org'
  );
}

/**
 * @param {string} url
 */
function isLinkedInProfileUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return false;
    return /\/in\//i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @returns {{ urls: string[], emails: string[], phones: string[], linkedin: string | null }}
 */
export function parseQrContactPayload(text) {
  const raw = String(text || '').trim();
  /** @type {string[]} */
  const urls = [];
  /** @type {string[]} */
  const emails = [];
  /** @type {string[]} */
  const phones = [];
  /** @type {string | null} */
  let linkedin = null;

  const pushUrl = (u) => {
    const n = normalizeHttpUrl(u);
    if (!n) return;
    try {
      if (isTelegramHost(new URL(n).hostname)) return;
    } catch {
      return;
    }
    if (isLinkedInProfileUrl(n)) {
      linkedin = linkedin || n;
      return;
    }
    if (!urls.includes(n)) urls.push(n);
  };
  const pushEmail = (e) => {
    const s = String(e || '').trim().toLowerCase();
    if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return;
    if (!emails.includes(s)) emails.push(s);
  };
  const pushPhone = (p) => {
    const s = String(p || '').trim().replace(/[^\d+() .\-]/g, '');
    if (s.replace(/\D/g, '').length < 7) return;
    if (!phones.includes(s)) phones.push(s);
  };

  if (!raw) return { urls, emails, phones, linkedin };

  // Skip wifi / geo / sms / mailto-only payloads without a useful contact URL.
  if (/^(WIFI|GEO|SMSTO|SMS|TEL|MATMSG):/i.test(raw) && !/^BEGIN:VCARD/i.test(raw)) {
    if (/^TEL:/i.test(raw)) pushPhone(raw.slice(4));
    if (/^MAILTO:/i.test(raw)) pushEmail(raw.slice(7));
    return { urls, emails, phones, linkedin };
  }

  if (/^MAILTO:/i.test(raw)) {
    pushEmail(raw.slice(7).split('?')[0]);
    return { urls, emails, phones, linkedin };
  }

  if (/^BEGIN:VCARD/i.test(raw)) {
    const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z0-9.-]+)(?:;[^:]*)?:(.+)$/i);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const val = m[2].trim();
      if (key === 'URL' || key === 'URLS') pushUrl(val);
      else if (key === 'EMAIL') pushEmail(val);
      else if (key === 'TEL') pushPhone(val);
    }
    // Some generators put a bare URL elsewhere in the vCard blob.
    for (const m of raw.matchAll(/https?:\/\/[^\s<>"']+/gi)) pushUrl(m[0]);
    return { urls, emails, phones, linkedin };
  }

  if (/^MECARD:/i.test(raw)) {
    const body = raw.slice(7);
    for (const part of body.split(';')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim().toUpperCase();
      const val = part.slice(idx + 1).trim();
      if (key === 'URL') pushUrl(val);
      else if (key === 'EMAIL') pushEmail(val);
      else if (key === 'TEL') pushPhone(val);
    }
    return { urls, emails, phones, linkedin };
  }

  // Plain URL or URL embedded in free text.
  const direct = normalizeHttpUrl(raw);
  if (direct) {
    pushUrl(direct);
    return { urls, emails, phones, linkedin };
  }
  for (const m of raw.matchAll(/https?:\/\/[^\s<>"']+/gi)) pushUrl(m[0]);
  return { urls, emails, phones, linkedin };
}

/**
 * @param {Buffer} rgba
 * @param {number} width
 * @param {number} height
 * @param {(data: Uint8ClampedArray, w: number, h: number, opts?: object) => { data?: string } | null} jsQR
 * @returns {string | null}
 */
function decodeRgba(rgba, width, height, jsQR) {
  try {
    const code = jsQR(new Uint8ClampedArray(rgba), width, height, {
      inversionAttempts: 'attemptBoth',
    });
    const text = code?.data != null ? String(code.data).trim() : '';
    return text || null;
  } catch {
    return null;
  }
}

/**
 * @param {Buffer} buf
 * @param {any} sharp
 * @param {{ maxEdge?: number, grayscale?: boolean, normalize?: boolean }} [opts]
 */
async function toRgba(buf, sharp, opts = {}) {
  const maxEdge = opts.maxEdge ?? MAX_EDGE;
  let pipeline = sharp(buf, { failOn: 'none' }).rotate();
  if (opts.grayscale) pipeline = pipeline.grayscale();
  if (opts.normalize) pipeline = pipeline.normalize();
  pipeline = pipeline.ensureAlpha().resize({
    width: maxEdge,
    height: maxEdge,
    fit: 'inside',
    withoutEnlargement: false,
  });
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Decode all useful contact fields from QR codes in an image buffer.
 * @param {Buffer} imageBuf
 * @returns {Promise<{
 *   payloads: string[],
 *   urls: string[],
 *   emails: string[],
 *   phones: string[],
 *   linkedin: string | null,
 * }>}
 */
export async function decodeContactQrFromImage(imageBuf) {
  const empty = { payloads: [], urls: [], emails: [], phones: [], linkedin: null };
  if (!Buffer.isBuffer(imageBuf) || imageBuf.length < 32) return empty;

  let sharp;
  let jsQR;
  try {
    sharp = (await import('sharp')).default;
    jsQR = (await import('jsqr')).default;
  } catch (e) {
    console.warn('[network-qr] sharp/jsqr unavailable', e?.message || e);
    return empty;
  }

  /** @type {string[]} */
  const payloads = [];
  const tries = [
    { maxEdge: MAX_EDGE, grayscale: false, normalize: false },
    { maxEdge: MAX_EDGE, grayscale: true, normalize: true },
    { maxEdge: 1200, grayscale: true, normalize: true },
    { maxEdge: 800, grayscale: true, normalize: true },
    { maxEdge: MIN_EDGE, grayscale: true, normalize: true },
  ];

  for (const t of tries) {
    try {
      const { data, width, height } = await toRgba(imageBuf, sharp, t);
      if (width < 40 || height < 40) continue;
      const text = decodeRgba(data, width, height, jsQR);
      if (text && !payloads.includes(text)) payloads.push(text);
    } catch {
      // best-effort
    }
  }

  if (!payloads.length) return empty;

  /** @type {string[]} */
  const urls = [];
  /** @type {string[]} */
  const emails = [];
  /** @type {string[]} */
  const phones = [];
  /** @type {string | null} */
  let linkedin = null;

  for (const p of payloads) {
    const parsed = parseQrContactPayload(p);
    for (const u of parsed.urls) {
      if (!urls.includes(u)) urls.push(u);
    }
    for (const e of parsed.emails) {
      if (!emails.includes(e)) emails.push(e);
    }
    for (const ph of parsed.phones) {
      if (!phones.includes(ph)) phones.push(ph);
    }
    if (!linkedin && parsed.linkedin) linkedin = parsed.linkedin;
  }

  return { payloads, urls, emails, phones, linkedin };
}

/**
 * Merge QR-decoded facts onto a contact enrich/update patch.
 * QR links are intentional on business cards — always promote onto the card
 * (do not apply LLM profile-URL name heuristics). Prefer QR over vision guesses.
 * @param {object} contact
 * @param {Record<string, unknown>} patch
 * @param {{ urls?: string[], emails?: string[], phones?: string[], linkedin?: string | null }} qr
 * @returns {string[]} field keys filled
 */
export function applyQrFactsToContactPatch(contact, patch, qr) {
  /** @type {string[]} */
  const filled = [];
  if (!contact || !patch || !qr) return filled;

  const channels = {
    ...((contact.channels && typeof contact.channels === 'object' ? contact.channels : {})),
    ...((patch.channels && typeof patch.channels === 'object' ? patch.channels : {})),
  };

  let channelsChanged = false;

  const linkedin = String(qr.linkedin || '').trim();
  if (linkedin && String(channels.linkedin || '').trim() !== linkedin) {
    channels.linkedin = linkedin;
    channelsChanged = true;
    filled.push('channels.linkedin');
  }

  const email = Array.isArray(qr.emails) ? String(qr.emails[0] || '').trim() : '';
  if (email && !String(channels.email || '').trim()) {
    channels.email = email;
    channelsChanged = true;
    filled.push('channels.email');
  }

  const phone = Array.isArray(qr.phones) ? String(qr.phones[0] || '').trim() : '';
  if (phone && !String(channels.phone || '').trim()) {
    channels.phone = phone;
    channelsChanged = true;
    filled.push('channels.phone');
  }

  const qrUrls = (Array.isArray(qr.urls) ? qr.urls : [])
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//i.test(u));
  if (qrUrls.length) {
    const prior = Array.isArray(channels.urls) ? channels.urls.map(String) : [];
    const merged = [...new Set([...prior, ...qrUrls])].slice(0, 20);
    if (merged.length !== prior.length || merged.some((u, i) => u !== prior[i])) {
      channels.urls = merged;
      channelsChanged = true;
      filled.push('channels.urls');
    }
  }

  if (channelsChanged) patch.channels = channels;

  // Keep enrichment.sources audit trail when present.
  if (qrUrls.length && patch.enrichment && typeof patch.enrichment === 'object') {
    const enr = /** @type {Record<string, unknown>} */ (patch.enrichment);
    const sources = [
      ...new Set([
        ...(Array.isArray(enr.sources) ? enr.sources.map(String) : []),
        ...qrUrls,
        ...(linkedin ? [linkedin] : []),
      ]),
    ].slice(0, 30);
    enr.sources = sources;
  }

  return filled;
}
