/**
 * Classify Dashbird Telegram intake messages: event | todo | note | contact | company.
 * Text/voice use a text model; photos use a vision intake-kind classifier.
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const DEFAULT_TEXT_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const TEXT_FALLBACK_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
];

const DEFAULT_VISION_MODEL = 'google/gemma-4-26b-a4b-it:free';
const VISION_FALLBACK_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
];

/** Contact-ish image kinds that create/update a Network person card. */
export const TELEGRAM_CONTACT_IMAGE_KINDS = new Set([
  'business_card',
  'linkedin_screenshot',
  'social_screenshot',
  'headshot',
  'guest_list',
]);

/** Company-ish image kinds that create/update a Network company card. */
export const TELEGRAM_COMPANY_IMAGE_KINDS = new Set(['company_logo']);

/** Max people to import from one guest-list screenshot. */
export const TELEGRAM_GUEST_LIST_MAX = 40;

const CLASSIFY_SYSTEM = `You classify a short message sent to a personal dashboard Telegram bot.
Return JSON only:
{
  "type": "event" | "todo" | "note" | "contact" | "company",
  "confidence": number,
  "reason": string,
  "todoText": string | null,
  "noteText": string | null,
  "contact": {
    "displayName": string | null,
    "aliases": string[],
    "kind": "friend" | "business" | null,
    "notes": string | null,
    "org": string | null,
    "title": string | null,
    "email": string | null,
    "phone": string | null,
    "officePhone": string | null,
    "telegram": string | null,
    "linkedin": string | null,
    "website": string | null,
    "location": string | null,
    "address": string | null
  } | null,
  "company": {
    "name": string | null,
    "website": string | null,
    "phone": string | null,
    "email": string | null,
    "linkedin": string | null,
    "notes": string | null
  } | null
}
Rules:
- event: party/meetup/show/invite with a time or clear event framing.
- todo: actionable task the user wants on a to-do list ("remind me to…", "todo:…", "buy…", "call…").
- contact: introducing or saving a person — including bare "Name + phone/email/linkedin", business intros, "met Sam…", "new contact…".
- company: saving an organization / business / brand (not a person) — "add company Acme", org name + website/phone.
- note: everything else worth keeping as freeform text that is not event/todo/contact/company.
- confidence: 0-1. If under 0.55, still pick best type but be honest about confidence.
- For contact, displayName is required when type=contact. Extract phone/officePhone/email/linkedin/org/title/address when present.
- phone: mobile/cell when distinguishable; otherwise the primary personal number.
- officePhone: office / work / desk line when labeled separately from mobile.
- location: city / metro; address: full mailing/street/P.O. Box when present.
- For company, name is required when type=company.
- For todo, todoText should be a short task title.
- For note, noteText is the cleaned note body.`;

const IMAGE_CLASSIFY_SYSTEM = `You classify a photo sent to a personal dashboard Telegram bot and extract CRM fields.
Return JSON only:
{
  "kind": "event_flyer" | "business_card" | "linkedin_screenshot" | "social_screenshot" | "headshot" | "company_logo" | "guest_list" | "other",
  "confidence": number,
  "reason": string,
  "hasHeadshot": boolean,
  "headshotCrop": { "x": number, "y": number, "w": number, "h": number } | null,
  "hasLogo": boolean,
  "logoCrop": { "x": number, "y": number, "w": number, "h": number } | null,
  "eventName": string | null,
  "contact": {
    "displayName": string | null,
    "aliases": string[],
    "kind": "friend" | "business" | null,
    "notes": string | null,
    "org": string | null,
    "title": string | null,
    "email": string | null,
    "phone": string | null,
    "officePhone": string | null,
    "telegram": string | null,
    "linkedin": string | null,
    "website": string | null,
    "location": string | null,
    "address": string | null
  } | null,
  "contacts": [
    {
      "displayName": string,
      "aliases": string[],
      "kind": "friend" | "business" | null,
      "notes": string | null,
      "org": string | null,
      "title": string | null,
      "email": string | null,
      "phone": string | null,
      "officePhone": string | null,
      "telegram": string | null,
      "linkedin": string | null,
      "website": string | null,
      "location": string | null,
      "address": string | null,
      "hasHeadshot": boolean,
      "headshotCrop": { "x": number, "y": number, "w": number, "h": number } | null
    }
  ],
  "company": {
    "name": string | null,
    "website": string | null,
    "phone": string | null,
    "email": string | null,
    "linkedin": string | null,
    "location": string | null,
    "notes": string | null
  } | null
}
Rules:
- business_card: photo/scan of a physical or digital business card.
- linkedin_screenshot: LinkedIn profile (or similar professional directory) screenshot.
- social_screenshot: Instagram / X / Facebook / About page / other social profile screenshot of a person.
- headshot: portrait / selfie / headshot of a person with little other CRM text (still extract name from caption if present).
- guest_list: RSVP / going / invitee / attendee list screenshot (Partiful, Luma, Eventbrite, Facebook, Secret Party, Meetup, spreadsheet, etc.) showing multiple people. Put every readable person into "contacts" (cap 40). Set eventName when the event title is visible. contact may mirror the first person or be null.
- company_logo: primarily a company logo / brand mark / wordmark (optionally with company name), not a person.
- event_flyer: party/meetup/show invite flyer or event page screenshot (poster/details — not a roster of names). Prefer guest_list when the screenshot is mainly a list of attendees/invitees.
- other: anything else (receipts, random photos) — prefer other over guessing event_flyer.
- hasHeadshot: true when a clear photo of the person's face is visible (card photo, LinkedIn avatar, portrait). For guest_list, set per-row hasHeadshot/headshotCrop on contacts[]; top-level hasHeadshot only if a single dominant face.
- headshotCrop / logoCrop: normalized 0-1 fractions of the full image (x,y = top-left; w,h = size). Prefer a tight square-ish crop around the face or logo, but keep each edge at least ~0.06 of the image so small marks still crop. Null when not visible.
- For business_card / linkedin / social: fill contact fields from visible text. Set company when an organization name is visible. contacts may be empty.
- For business_card: always set contact.kind to "business".
- phone: mobile/cell when the card labels Cell/Mobile/C; otherwise the primary personal number.
- officePhone: office / work / desk / O: line when labeled separately. On cards with both Office and Cell, put each in the matching field.
- location: city / metro freeform (e.g. "Livermore, CA").
- address: full mailing / street / P.O. Box line(s) when visible (keep separate from location).
- For company_logo: fill company.name (required). contact may be null.
- Prefer null over inventing emails/phones/URLs not visible in the image or caption.
- confidence: 0-1.`;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openRouterKey(env = process.env) {
  return String(env.OPENROUTER_API_KEY || '').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function textModel(env = process.env) {
  return String(
    env.TELEGRAM_CLASSIFIER_MODEL
      || env.TELEGRAM_EVENTS_TEXT_MODEL
      || env.OPENROUTER_FREE_TEXT_MODEL
      || DEFAULT_TEXT_MODEL,
  ).trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function visionModel(env = process.env) {
  return String(
    env.TELEGRAM_CLASSIFIER_VISION_MODEL
      || env.TELEGRAM_EVENTS_VISION_MODEL
      || env.NETWORK_ENRICH_VISION_MODEL
      || env.OPENROUTER_FREE_VISION_MODEL
      || DEFAULT_VISION_MODEL,
  ).trim();
}

/**
 * @param {string} primary
 * @param {string[]} fallbacks
 */
function modelChain(primary, fallbacks) {
  return [...new Set([String(primary || '').trim(), ...fallbacks].filter(Boolean))];
}

/**
 * @param {string} text
 */
function extractJsonObject(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Pull phone / email / linkedin / website hints from freeform contact text.
 * @param {string} text
 */
export function extractContactHintsFromText(text) {
  const body = String(text || '').trim();
  /** @type {{ displayName: string | null, phone: string | null, officePhone: string | null, email: string | null, linkedin: string | null, website: string | null, telegram: string | null, org: string | null, notes: string }} */
  const out = {
    displayName: null,
    phone: null,
    officePhone: null,
    email: null,
    linkedin: null,
    website: null,
    telegram: null,
    org: null,
    notes: body,
  };
  if (!body) return out;

  const email = body.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  if (email) out.email = email[0];

  const linkedin = body.match(/https?:\/\/(?:[\w.-]+\.)?linkedin\.com\/[^\s<>"']+/i);
  if (linkedin) out.linkedin = linkedin[0].replace(/[),.]+$/g, '');

  const website = body.match(/https?:\/\/[^\s<>"']+/i);
  if (website && !/linkedin\.com/i.test(website[0])) {
    out.website = website[0].replace(/[),.]+$/g, '');
  }

  const phoneRe =
    /(?:\+1[\s.-]?|\+(?!1)\d{1,3}[\s.-])?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b|\+\d{8,15}\b/;
  const officeLabeled = body.match(
    new RegExp(
      `(?:office|work|desk|o)\\s*[:.#\\-]*\\s*(${phoneRe.source})`,
      'i',
    ),
  );
  if (officeLabeled) out.officePhone = officeLabeled[1].trim();

  const cellLabeled = body.match(
    new RegExp(
      `(?:cell|mobile|c)\\s*[:.#\\-]*\\s*(${phoneRe.source})`,
      'i',
    ),
  );
  if (cellLabeled) out.phone = cellLabeled[1].trim();

  if (!out.phone) {
    const phone = body.match(phoneRe);
    if (phone && phone[0].trim() !== out.officePhone) out.phone = phone[0].trim();
  }

  const tg = body.match(/(?:^|[\s,])@([A-Za-z][\w]{3,31})\b/);
  if (tg && !/gmail|yahoo|hotmail/i.test(tg[1])) out.telegram = `@${tg[1]}`;

  const org = body.match(/\b(?:at|@|from)\s+([A-Z][\w&.'' -]{1,60})/);
  if (org) out.org = org[1].trim().replace(/[.,;]+$/, '');

  // First comma/newline segment is usually the name when not a URL-only message.
  const first = body.split(/[,\n|;]/)[0]?.trim() || '';
  let nameCandidate = first
    .replace(/^(?:\/)?(?:contact|friend|met|company|org|organization)\b[:\s-]*/i, '')
    .replace(/\b(?:business\s*card|linkedin|headshot|profile\s*screenshot|contact\s*card|logo)\b(?:\s+for)?\s*/gi, '')
    .replace(out.phone || '', '')
    .replace(out.officePhone || '', '')
    .replace(out.email || '', '')
    .replace(out.linkedin || '', '')
    .replace(out.website || '', '')
    .replace(out.telegram || '', '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[\s,:|-]+|[\s,:|-]+$/g, '');
  // "Jane Doe 555…" without commas — strip trailing phone-like tokens.
  nameCandidate = nameCandidate
    .replace(/(?:\+1[\s.-]?|\+(?!1)\d{1,3}[\s.-])?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b.*$/u, '')
    .replace(/\+\d{8,15}\b.*$/u, '')
    .trim();
  if (nameCandidate && !/^https?:\/\//i.test(nameCandidate) && nameCandidate.length >= 2) {
    out.displayName = nameCandidate.slice(0, 200);
  }
  return out;
}

/**
 * Explicit command override: /event /todo /note /contact /company …
 * @param {string} text
 * @returns {{ type: string, rest: string } | null}
 */
export function parseTelegramTypeOverride(text) {
  const s = String(text || '').trim();
  const m = s.match(/^\/(event|todo|note|contact|company)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { type: m[1].toLowerCase(), rest: String(m[2] || '').trim() };
}

/**
 * Keep a raw crop object with finite numbers for later normalize+extract.
 * Full 0–1 / % / px normalization happens in cropImageRegion (needs image size).
 * @param {unknown} raw
 * @returns {{ x: number, y: number, w: number, h: number } | null}
 */
function keepRawCrop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(/** @type {any} */ (raw).x);
  const y = Number(/** @type {any} */ (raw).y);
  const w = Number(/** @type {any} */ (raw).w ?? /** @type {any} */ (raw).width);
  const h = Number(/** @type {any} */ (raw).h ?? /** @type {any} */ (raw).height);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * Normalize a 0–1 crop box; returns null if unusable.
 * Accepts 0–1 fractions, 0–100 percentages, or (with imageSize) pixel boxes.
 * Tiny logo/face boxes are expanded around their center so they survive the min size floor.
 *
 * @param {unknown} raw
 * @param {{ width?: number, height?: number, minSize?: number }} [opts]
 * @returns {{ x: number, y: number, w: number, h: number } | null}
 */
export function normalizeImageCrop(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  let x = Number(/** @type {any} */ (raw).x);
  let y = Number(/** @type {any} */ (raw).y);
  let w = Number(/** @type {any} */ (raw).w ?? /** @type {any} */ (raw).width);
  let h = Number(/** @type {any} */ (raw).h ?? /** @type {any} */ (raw).height);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;

  const imgW = Number(opts.width) || 0;
  const imgH = Number(opts.height) || 0;
  const maxCoord = Math.max(x, y, x + w, y + h);

  // Pixel boxes when clearly larger than a 0–1 / 0–100 fraction space.
  if (imgW > 0 && imgH > 0 && maxCoord > 100) {
    x /= imgW;
    y /= imgH;
    w /= imgW;
    h /= imgH;
  } else if (maxCoord > 1.0001 && maxCoord <= 100) {
    // Percentages 0–100 (common VLM output).
    x /= 100;
    y /= 100;
    w /= 100;
    h /= 100;
  }

  // Expand undersized boxes around center (card logos are often <5% of the frame).
  const minSize = Math.max(0.01, Math.min(0.2, Number(opts.minSize) || 0.04));
  if (w < minSize || h < minSize) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    w = Math.max(w, minSize);
    h = Math.max(h, minSize);
    x = cx - w / 2;
    y = cy - h / 2;
  }

  const nx = Math.max(0, Math.min(0.98, x));
  const ny = Math.max(0, Math.min(0.98, y));
  const nw = Math.max(minSize, Math.min(1 - nx, w));
  const nh = Math.max(minSize, Math.min(1 - ny, h));
  if (nw < 0.01 || nh < 0.01) return null;
  return { x: nx, y: ny, w: nw, h: nh };
}

/**
 * Crop a region from an image buffer using a normalized 0–1 box.
 * @param {Buffer} buf
 * @param {{ x: number, y: number, w: number, h: number } | null | undefined} crop
 * @param {{ maxEdge?: number }} [opts]
 * @returns {Promise<Buffer | null>}
 */
export async function cropImageRegion(buf, crop, opts = {}) {
  if (!crop || !Buffer.isBuffer(buf) || buf.length < 32) return null;
  try {
    const { default: sharp } = await import('sharp');
    const meta = await sharp(buf, { failOn: 'none' }).rotate().metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!width || !height) return null;
    const box = normalizeImageCrop(crop, { width, height });
    if (!box) return null;
    const left = Math.max(0, Math.min(width - 1, Math.floor(box.x * width)));
    const top = Math.max(0, Math.min(height - 1, Math.floor(box.y * height)));
    const extractW = Math.max(8, Math.min(width - left, Math.ceil(box.w * width)));
    const extractH = Math.max(8, Math.min(height - top, Math.ceil(box.h * height)));
    const maxEdge = Math.max(64, Math.min(1600, Number(opts.maxEdge) || 800));
    return await sharp(buf, { failOn: 'none' })
      .rotate()
      .extract({ left, top, width: extractW, height: extractH })
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * @param {unknown} contact
 * @param {{ allowHeadshotMeta?: boolean }} [opts]
 */
function normalizeContactPayload(contact, opts = {}) {
  if (!contact || typeof contact !== 'object') return null;
  const c = /** @type {Record<string, unknown>} */ (contact);
  const displayName = String(c.displayName || '').trim() || null;
  /** @type {Record<string, unknown>} */
  const out = {
    displayName,
    aliases: Array.isArray(c.aliases)
      ? c.aliases.map((a) => String(a).trim()).filter(Boolean).slice(0, 20)
      : [],
    kind: c.kind === 'business' ? 'business' : c.kind === 'friend' ? 'friend' : null,
    notes: c.notes != null ? String(c.notes).trim().slice(0, 4000) : null,
    org: c.org != null ? String(c.org).trim().slice(0, 300) : null,
    title: c.title != null ? String(c.title).trim().slice(0, 300) : null,
    email: c.email != null ? String(c.email).trim().slice(0, 320) : null,
    phone: c.phone != null ? String(c.phone).trim().slice(0, 80) : null,
    officePhone:
      c.officePhone != null || c.office_phone != null
        ? String(c.officePhone ?? c.office_phone).trim().slice(0, 80)
        : null,
    telegram: c.telegram != null ? String(c.telegram).trim().slice(0, 120) : null,
    linkedin: c.linkedin != null ? String(c.linkedin).trim().slice(0, 500) : null,
    website: c.website != null ? String(c.website).trim().slice(0, 500) : null,
    location: c.location != null ? String(c.location).trim().slice(0, 300) : null,
    address: c.address != null ? String(c.address).trim().slice(0, 500) : null,
  };
  if (opts.allowHeadshotMeta) {
    out.hasHeadshot = Boolean(c.hasHeadshot);
    out.headshotCrop = keepRawCrop(c.headshotCrop) || normalizeImageCrop(c.headshotCrop);
  }
  return out;
}

/**
 * @param {unknown} list
 * @returns {object[]}
 */
function normalizeContactsList(list) {
  if (!Array.isArray(list)) return [];
  /** @type {object[]} */
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const n = normalizeContactPayload(item, { allowHeadshotMeta: true });
    const name = String(n?.displayName || '').trim();
    if (!n || !name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= TELEGRAM_GUEST_LIST_MAX) break;
  }
  return out;
}

/**
 * @param {unknown} company
 */
function normalizeCompanyPayload(company) {
  if (!company || typeof company !== 'object') return null;
  const c = /** @type {Record<string, unknown>} */ (company);
  const name = String(c.name || '').trim() || null;
  return {
    name,
    website: c.website != null ? String(c.website).trim().slice(0, 500) : null,
    phone: c.phone != null ? String(c.phone).trim().slice(0, 80) : null,
    email: c.email != null ? String(c.email).trim().slice(0, 320) : null,
    linkedin: c.linkedin != null ? String(c.linkedin).trim().slice(0, 500) : null,
    location: c.location != null ? String(c.location).trim().slice(0, 300) : null,
    notes: c.notes != null ? String(c.notes).trim().slice(0, 4000) : null,
  };
}

/**
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ ok: boolean, type?: string, confidence?: number, reason?: string, todoText?: string | null, noteText?: string | null, contact?: object | null, company?: object | null, error?: string }>}
 */
export async function classifyTelegramMessage(text, env = process.env) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'empty' };

  const override = parseTelegramTypeOverride(body);
  if (override) {
    const rest = override.rest || body;
    if (override.type === 'todo') {
      return {
        ok: true,
        type: 'todo',
        confidence: 1,
        reason: 'command_override',
        todoText: rest,
        noteText: null,
        contact: null,
        company: null,
      };
    }
    if (override.type === 'note') {
      return {
        ok: true,
        type: 'note',
        confidence: 1,
        reason: 'command_override',
        todoText: null,
        noteText: rest,
        contact: null,
        company: null,
      };
    }
    if (override.type === 'contact') {
      const hints = extractContactHintsFromText(rest);
      return {
        ok: true,
        type: 'contact',
        confidence: 1,
        reason: 'command_override',
        todoText: null,
        noteText: null,
        contact: {
          displayName: hints.displayName || rest.split(/[,\n]/)[0]?.trim() || rest,
          notes: rest,
          aliases: [],
          kind: 'friend',
          org: hints.org,
          email: hints.email,
          phone: hints.phone,
          officePhone: hints.officePhone,
          telegram: hints.telegram,
          linkedin: hints.linkedin,
          website: hints.website,
        },
        company: null,
      };
    }
    if (override.type === 'company') {
      const hints = extractContactHintsFromText(rest);
      return {
        ok: true,
        type: 'company',
        confidence: 1,
        reason: 'command_override',
        todoText: null,
        noteText: null,
        contact: null,
        company: {
          name: hints.displayName || rest.split(/[,\n]/)[0]?.trim() || rest,
          website: hints.website,
          phone: hints.phone,
          email: hints.email,
          linkedin: hints.linkedin,
          notes: rest,
        },
      };
    }
    return {
      ok: true,
      type: 'event',
      confidence: 1,
      reason: 'command_override',
      todoText: null,
      noteText: null,
      contact: null,
      company: null,
    };
  }

  if (!openRouterKey(env)) {
    const hints = extractContactHintsFromText(body);
    if (hints.displayName && (hints.phone || hints.email || hints.linkedin)) {
      return {
        ok: true,
        type: 'contact',
        confidence: 0.7,
        reason: 'openrouter_missing_contact_hints',
        todoText: null,
        noteText: null,
        contact: {
          displayName: hints.displayName,
          notes: body,
          aliases: [],
          kind: 'friend',
          org: hints.org,
          email: hints.email,
          phone: hints.phone,
          officePhone: hints.officePhone,
          telegram: hints.telegram,
          linkedin: hints.linkedin,
          website: hints.website,
          title: null,
          location: null,
        },
        company: null,
      };
    }
    // Without OpenRouter, default to event path (legacy behavior).
    return {
      ok: true,
      type: 'event',
      confidence: 0.4,
      reason: 'openrouter_missing_default_event',
      todoText: null,
      noteText: null,
      contact: null,
      company: null,
    };
  }

  const models = modelChain(textModel(env), TEXT_FALLBACK_MODELS);
  let lastError = 'openrouter_failed';
  for (const model of models) {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterKey(env)}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
        'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-telegram-classifier',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        // Free-tier OpenRouter rejects uncapped completion budgets (defaults to 16k → HTTP 402).
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: body.slice(0, 4000) },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!r.ok) {
      lastError = `openrouter_http_${r.status}`;
      if (r.status === 401 || r.status === 403) break;
      if (r.status === 402 || r.status === 429 || r.status >= 500) continue;
      break;
    }
    const j = await r.json();
    const parsed = extractJsonObject(j?.choices?.[0]?.message?.content);
    if (!parsed || typeof parsed !== 'object') {
      lastError = 'parse_failed';
      continue;
    }

    const type = String(parsed.type || '').toLowerCase();
    if (!['event', 'todo', 'note', 'contact', 'company'].includes(type)) {
      lastError = 'bad_type';
      continue;
    }

    return {
      ok: true,
      type,
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason || '').slice(0, 400) || null,
      todoText: parsed.todoText != null ? String(parsed.todoText).trim() : null,
      noteText: parsed.noteText != null ? String(parsed.noteText).trim() : body,
      contact: normalizeContactPayload(parsed.contact),
      company: normalizeCompanyPayload(parsed.company),
    };
  }

  return { ok: false, error: lastError };
}

/**
 * Vision classify a Telegram photo: event flyer vs CRM card/screenshot/logo/guest list.
 * @param {string} dataUrl
 * @param {string} [caption]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{
 *   ok: boolean,
 *   kind?: string,
 *   confidence?: number,
 *   reason?: string | null,
 *   hasHeadshot?: boolean,
 *   headshotCrop?: { x: number, y: number, w: number, h: number } | null,
 *   hasLogo?: boolean,
 *   logoCrop?: { x: number, y: number, w: number, h: number } | null,
 *   eventName?: string | null,
 *   contact?: object | null,
 *   contacts?: object[],
 *   company?: object | null,
 *   error?: string,
 * }>}
 */
export async function classifyTelegramImage(dataUrl, caption = '', env = process.env) {
  const url = String(dataUrl || '').trim();
  if (!url.startsWith('data:image/')) return { ok: false, error: 'invalid_image' };
  if (!openRouterKey(env)) return { ok: false, error: 'openrouter_not_configured' };

  const cap = String(caption || '').trim().slice(0, 1000);
  const models = modelChain(visionModel(env), VISION_FALLBACK_MODELS);
  let lastError = 'openrouter_failed';

  for (const model of models) {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterKey(env)}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
        'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-telegram-image-classifier',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: IMAGE_CLASSIFY_SYSTEM },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: cap
                  ? `Caption from user: ${cap}\nClassify this image and extract CRM fields. If it is a guest/RSVP/attendee list, extract every readable name into contacts.`
                  : 'Classify this image and extract CRM fields. If it is a guest/RSVP/attendee list, extract every readable name into contacts. No caption provided.',
              },
              { type: 'image_url', image_url: { url } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!r.ok) {
      lastError = `openrouter_http_${r.status}`;
      if (r.status === 401 || r.status === 403) break;
      if (r.status === 402 || r.status === 429 || r.status >= 500) continue;
      break;
    }

    const j = await r.json();
    const parsed = extractJsonObject(j?.choices?.[0]?.message?.content);
    if (!parsed || typeof parsed !== 'object') {
      lastError = 'parse_failed';
      continue;
    }

    const kind = String(parsed.kind || '').toLowerCase().trim();
    const allowed = [
      'event_flyer',
      'business_card',
      'linkedin_screenshot',
      'social_screenshot',
      'headshot',
      'company_logo',
      'guest_list',
      'other',
    ];
    if (!allowed.includes(kind)) {
      lastError = 'bad_kind';
      continue;
    }

    // Caption overrides can nudge kind when vision is unsure.
    const override = parseTelegramTypeOverride(cap);
    let finalKind = kind;
    if (override?.type === 'contact' && kind === 'other') finalKind = 'business_card';
    if (override?.type === 'company' && (kind === 'other' || kind === 'event_flyer')) {
      finalKind = 'company_logo';
    }
    if (override?.type === 'event') finalKind = 'event_flyer';
    if (/\b(guest\s*list|rsvp\s*list|attendee|going\s*list|invitee)\b/i.test(cap) && kind === 'other') {
      finalKind = 'guest_list';
    }

    let contacts = normalizeContactsList(parsed.contacts);
    const contact = normalizeContactPayload(parsed.contact);
    if (finalKind === 'business_card' && contact) {
      contact.kind = 'business';
    }
    // Promote single contact → contacts when guest_list returned only contact.
    if (finalKind === 'guest_list' && !contacts.length && contact?.displayName) {
      contacts = [contact];
    }
    // Multi-name lists mislabeled as flyer/other → treat as guest_list.
    if (contacts.length >= 2 && (finalKind === 'other' || finalKind === 'event_flyer')) {
      finalKind = 'guest_list';
    }

    return {
      ok: true,
      kind: finalKind,
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason || '').slice(0, 400) || null,
      hasHeadshot: Boolean(parsed.hasHeadshot),
      headshotCrop: keepRawCrop(parsed.headshotCrop) || normalizeImageCrop(parsed.headshotCrop),
      hasLogo: Boolean(parsed.hasLogo),
      logoCrop: keepRawCrop(parsed.logoCrop) || normalizeImageCrop(parsed.logoCrop),
      eventName: parsed.eventName != null ? String(parsed.eventName).trim().slice(0, 300) || null : null,
      contact,
      contacts,
      company: normalizeCompanyPayload(parsed.company),
    };
  }

  return { ok: false, error: lastError };
}

/**
 * Caption / filename heuristics when vision classify fails.
 * @param {string} caption
 * @returns {{ ok: true, kind: string, confidence: number, reason: string, hasHeadshot: boolean, hasLogo: boolean, contact: object | null, company: object | null } | null}
 */
export function heuristicTelegramImageClassify(caption = '') {
  const body = String(caption || '').trim();
  const lower = body.toLowerCase();
  const override = parseTelegramTypeOverride(body);
  if (override?.type === 'contact') {
    const hints = extractContactHintsFromText(override.rest || body);
    return {
      ok: true,
      kind: 'business_card',
      confidence: 0.7,
      reason: 'heuristic_caption_contact',
      hasHeadshot: false,
      hasLogo: false,
      contact: {
        displayName: hints.displayName,
        notes: override.rest || body,
        aliases: [],
        kind: 'friend',
        org: hints.org,
        email: hints.email,
        phone: hints.phone,
        officePhone: hints.officePhone,
        telegram: hints.telegram,
        linkedin: hints.linkedin,
        website: hints.website,
        location: null,
        title: null,
      },
      contacts: [],
      eventName: null,
      company: null,
    };
  }
  if (override?.type === 'company') {
    const hints = extractContactHintsFromText(override.rest || body);
    return {
      ok: true,
      kind: 'company_logo',
      confidence: 0.7,
      reason: 'heuristic_caption_company',
      hasHeadshot: false,
      hasLogo: true,
      contact: null,
      contacts: [],
      eventName: null,
      company: {
        name: hints.displayName,
        website: hints.website,
        phone: hints.phone,
        email: hints.email,
        linkedin: hints.linkedin,
        location: null,
        notes: override.rest || body,
      },
    };
  }
  if (/\b(guest\s*list|rsvp\s*list|attendee\s*list|going\s*list|invitee\s*list|guestlist)\b/i.test(lower)) {
    return {
      ok: true,
      kind: 'guest_list',
      confidence: 0.65,
      reason: 'heuristic_caption_guest_list',
      hasHeadshot: false,
      hasLogo: false,
      contact: null,
      contacts: [],
      eventName: body
        .replace(/\b(guest\s*list|rsvp\s*list|attendee\s*list|going\s*list|invitee\s*list|guestlist)\b/gi, '')
        .replace(/^[\s,:|-]+|[\s,:|-]+$/g, '')
        .slice(0, 200) || null,
      company: null,
    };
  }
  if (
    /\b(business\s*card|linkedin|headshot|profile\s*screenshot|contact\s*card)\b/i.test(lower)
    || /\b(instagram|facebook\.com\/|x\.com\/|twitter\.com\/)\b/i.test(lower)
  ) {
    const hints = extractContactHintsFromText(body);
    let kind = 'social_screenshot';
    if (/business\s*card/i.test(lower)) kind = 'business_card';
    else if (/linkedin/i.test(lower)) kind = 'linkedin_screenshot';
    else if (/headshot|portrait|selfie/i.test(lower)) kind = 'headshot';
    return {
      ok: true,
      kind,
      confidence: 0.6,
      reason: 'heuristic_caption_crm',
      hasHeadshot: kind === 'headshot' || /headshot|portrait|photo/i.test(lower),
      hasLogo: false,
      contact: {
        displayName: hints.displayName,
        notes: body,
        aliases: [],
        kind: 'friend',
        org: hints.org,
        email: hints.email,
        phone: hints.phone,
        officePhone: hints.officePhone,
        telegram: hints.telegram,
        linkedin: hints.linkedin,
        website: hints.website,
        location: null,
        title: null,
      },
      contacts: [],
      eventName: null,
      company: null,
    };
  }
  if (/\b(logo|company\s*card|brand\s*mark)\b/i.test(lower)) {
    const hints = extractContactHintsFromText(body);
    return {
      ok: true,
      kind: 'company_logo',
      confidence: 0.6,
      reason: 'heuristic_caption_logo',
      hasHeadshot: false,
      hasLogo: true,
      contact: null,
      contacts: [],
      eventName: null,
      company: {
        name: hints.displayName,
        website: hints.website,
        phone: hints.phone,
        email: hints.email,
        linkedin: hints.linkedin,
        location: null,
        notes: body,
      },
    };
  }
  return null;
}
