/**
 * Build tap-to-open app deep links from Network contact channels.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Digits only, keeping a leading + for international when present in source.
 * @param {string} raw
 * @returns {string}
 */
export function digitsOnly(raw) {
  const s = clean(raw);
  if (!s) return '';
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function telHref(raw) {
  const d = digitsOnly(raw);
  return d ? `tel:${d}` : '';
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function smsHref(raw) {
  const d = digitsOnly(raw);
  return d ? `sms:${d}` : '';
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function mailtoHref(raw) {
  const email = clean(raw);
  if (!email || !email.includes('@')) return '';
  return `mailto:${encodeURIComponent(email).replace(/%40/g, '@')}`;
}

/**
 * @param {string} raw
 * @param {string} [fallbackPhone]
 * @returns {string}
 */
export function waMeHref(raw, fallbackPhone = '') {
  const source = clean(raw) || clean(fallbackPhone);
  const digits = source.replace(/\D/g, '');
  if (!digits) return '';
  return `https://wa.me/${digits}`;
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function signalHref(raw) {
  const s = clean(raw);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const digits = digitsOnly(s);
  const bare = digits.replace(/^\+/, '');
  if (bare.length >= 7 && bare.length <= 15) {
    const e164 = digits.startsWith('+') ? digits : `+${digits}`;
    return `https://signal.me/#p/${encodeURIComponent(e164)}`;
  }
  /* Username / unclear — no reliable deep link */
  return '';
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function linkedinHref(raw) {
  const s = clean(raw);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+$/.test(s)) return `https://www.linkedin.com/in/${encodeURIComponent(s)}`;
  return '';
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function telegramHref(raw) {
  const s = clean(raw);
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || /^tg:\/\//i.test(s)) return s;
  const handle = s.replace(/^@/, '');
  if (/^[A-Za-z0-9_]{3,}$/.test(handle)) return `https://t.me/${encodeURIComponent(handle)}`;
  const digits = digitsOnly(s);
  if (digits) return `https://t.me/+${digits.replace(/^\+/, '')}`;
  return '';
}

/**
 * @param {string} url
 * @returns {string}
 */
function messengerFromUrl(url) {
  const s = clean(url);
  if (!s) return '';
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'm.me' || host === 'www.m.me') return u.href;
    if (host === 'messenger.com' || host.endsWith('.messenger.com')) return u.href;
    if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com' || host.endsWith('.fb.com')) {
      const path = u.pathname.replace(/\/+$/, '');
      const m = path.match(/^\/(?:profile\.php)?$/i)
        ? null
        : path.match(/^\/(?:people\/[^/]+\/)?([^/?#]+)/i);
      if (u.searchParams.get('id')) {
        return `https://m.me/${encodeURIComponent(u.searchParams.get('id'))}`;
      }
      if (m && m[1] && !/^(pages|groups|events|watch|marketplace|login)$/i.test(m[1])) {
        return `https://m.me/${encodeURIComponent(m[1])}`;
      }
      return u.href;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function messengerValueHref(raw) {
  const s = clean(raw);
  if (!s) return '';
  const fromUrl = messengerFromUrl(s);
  if (fromUrl) return fromUrl;
  if (/^https?:\/\//i.test(s)) return s;
  /* Username / page slug → m.me */
  const handle = s.replace(/^@/, '').replace(/^m\.me\//i, '');
  if (/^[A-Za-z0-9._-]+$/.test(handle)) return `https://m.me/${encodeURIComponent(handle)}`;
  return '';
}

/**
 * @param {{ messenger?: string | null, other?: string | null, urls?: string[] }} channels
 * @returns {string}
 */
export function messengerHref(channels) {
  const direct = messengerValueHref(channels?.messenger);
  if (direct) return direct;
  const other = clean(channels?.other);
  const fromOther = messengerFromUrl(other);
  if (fromOther) return fromOther;
  const urls = Array.isArray(channels?.urls) ? channels.urls : [];
  for (const u of urls) {
    const hit = messengerFromUrl(u);
    if (hit) return hit;
  }
  if (/facebook|messenger|m\.me/i.test(other) && /^https?:\/\//i.test(other)) return other;
  return '';
}

/**
 * @typedef {{ id: string, label: string, href: string, copyValue?: string }} ContactAction
 */

/**
 * @param {object} contact
 * @returns {ContactAction[]}
 */
export function contactActions(contact) {
  const ch = contact?.channels && typeof contact.channels === 'object' ? contact.channels : {};
  const preferred = new Set(
    Array.isArray(contact?.preferredContactMethods)
      ? contact.preferredContactMethods.map((m) => String(m))
      : [],
  );
  /** @type {ContactAction[]} */
  const actions = [];

  /**
   * @param {string} id
   * @param {string} label
   * @param {string} href
   * @param {string} [copyValue]
   */
  function push(id, label, href, copyValue) {
    if (!href && !copyValue) return;
    actions.push({ id, label, href: href || '', copyValue: copyValue || undefined });
  }

  const phone = clean(ch.phone);
  const office = clean(ch.officePhone);
  const email = clean(ch.email);
  const sms = clean(ch.sms) || phone;
  const signal = clean(ch.signal);
  const whatsapp = clean(ch.whatsapp);
  const telegram = clean(ch.telegram);
  const linkedin = clean(ch.linkedin);

  if (phone) push('phone', 'Phone', telHref(phone));
  if (office) push('office_phone', 'Office', telHref(office));
  if (email) push('email', 'Email', mailtoHref(email));
  if (sms && (preferred.has('phone') || clean(ch.sms) || preferred.size === 0)) {
    push('sms', 'Text', smsHref(sms));
  }

  const wa = waMeHref(whatsapp, preferred.has('whatsapp') || whatsapp ? phone : '');
  if (wa) push('whatsapp', 'WhatsApp', wa);

  const sig = signalHref(signal || (preferred.has('signal') ? phone : ''));
  if (sig) {
    push('signal', 'Signal', sig);
  } else if (signal) {
    push('signal', 'Signal', '', signal);
  }

  const tg = telegramHref(telegram);
  if (tg) push('telegram', 'Telegram', tg);
  else if (telegram) push('telegram', 'Telegram', '', telegram);

  const msg = messengerHref(ch);
  if (msg) push('messenger', 'Messenger', msg);

  const li = linkedinHref(linkedin);
  if (li) push('linkedin', 'LinkedIn', li);

  /* Prefer preferred methods first when present */
  if (preferred.size) {
    const order = ['phone', 'office_phone', 'email', 'sms', 'signal', 'whatsapp', 'messenger', 'telegram', 'linkedin'];
    actions.sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      const ap = preferred.has(a.id === 'office_phone' ? 'office_phone' : a.id) ? 0 : 1;
      const bp = preferred.has(b.id === 'office_phone' ? 'office_phone' : b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }

  return actions;
}
