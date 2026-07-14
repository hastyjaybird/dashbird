/**
 * Network contacts CRM — SQLite (data/network.db) + assets on disk.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JULIA_CONTACT_ID,
  JULIA_SEED_ID,
  allocateNextContactId,
  openNetworkDb,
  remapLegacyNetworkId,
  removeContactRefs,
  rowToContact,
  upsertContactRow,
} from './network-db.js';
import { normalizeLastContactFields } from './network-last-contact.js';
import {
  normalizeContactDisplayName,
  relocateOutOfTownFromScenes,
} from './network-scene-normalize.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export { JULIA_CONTACT_ID, JULIA_SEED_ID };

export const CONTACT_KINDS = ['friend', 'organizer', 'business'];

export const CONTACT_RATINGS = ['Fan', 'Hot', 'Warm', 'Cold'];

/** Adult / raunchy plans comfort: Down = strip club fine; Proper = keep it clean. */
export const CONTACT_SENSITIVITIES = ['Down', 'Situational', 'Proper'];

export const CONTACT_RELATIONSHIP_STATUSES = [
  'Lead',
  'Acquaintance',
  'Cultivating',
  'Inner Circle',
  'Collaborator',
  'Meta',
  'Family',
  'Paused',
  'Former',
];

/** @deprecated use CONTACT_RELATIONSHIP_STATUSES */
export const CONTACT_LIFECYCLES = ['Lead', 'Active', 'Dormant', 'Former'];

export const PREFERRED_CONTACT_METHODS = [
  'phone',
  'office_phone',
  'email',
  'signal',
  'whatsapp',
  'linkedin',
  'other',
];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @deprecated JSON path unused; kept for callers that probe config.
 */
export function networkContactsPath(env = process.env) {
  const override = String(env.NETWORK_CONTACTS_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/network-contacts.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function networkAssetsDir(env = process.env) {
  const override = String(env.NETWORK_ASSETS_DIR || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/network-assets');
}

/**
 * @param {unknown} v
 */
function cleanStr(v, max = 2000) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.slice(0, max);
}

/**
 * Title-case a single name token (handles hyphens / apostrophes).
 * @param {string} word
 */
function titleCaseWord(word) {
  if (!word) return '';
  return word
    .split(/(['’])/)
    .map((seg) => {
      if (seg === "'" || seg === '’') return seg;
      if (!seg) return seg;
      return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
    })
    .join('');
}

/**
 * Short middle-initial tokens (LS, MJ, A, L.S.) stay uppercase with the given name.
 * Ordinary short middle names (Ann, Lee, Mae) stay title-cased.
 * @param {string} word
 */
function isMiddleInitialsToken(word) {
  const raw = String(word || '').trim();
  if (/^[A-Za-z](\.[A-Za-z])+\.?$/.test(raw)) return true;
  const w = raw.replace(/\./g, '');
  if (!/^[A-Za-z]{1,3}$/.test(w)) return false;
  if (w.length <= 2) return true;
  return w === w.toUpperCase();
}

/**
 * Title-case given name(s); middle initials stay UPPER with the first name.
 * @param {string} s
 */
function titleCaseGivenName(s) {
  const parts = String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts
    .map((p, i) => {
      if (i > 0 && isMiddleInitialsToken(p)) return p.replace(/\./g, '').toUpperCase();
      return titleCaseWord(p);
    })
    .join(' ');
}

/**
 * Title-case a person name: capitalize the first letter of each word
 * (and after hyphens / apostrophes). Middle initials stay with the given name as UPPER.
 * @param {string} s
 */
function titleCaseName(s) {
  if (!s) return '';
  const parts = String(s)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length <= 1) return titleCaseWord(parts[0] || '');
  const last = titleCaseWord(parts[parts.length - 1]);
  const given = titleCaseGivenName(parts.slice(0, -1).join(' '));
  return `${given} ${last}`.trim();
}

/**
 * Split a display name so middle names/initials stay on firstName; last token → lastName.
 * @param {unknown} displayName
 * @returns {{ firstName: string, lastName: string }}
 */
export function splitPersonName(displayName) {
  const parts = String(displayName ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}

/**
 * @param {unknown} firstName
 * @param {unknown} lastName
 */
export function composeDisplayName(firstName, lastName) {
  return [String(firstName ?? '').replace(/\s+/g, ' ').trim(), String(lastName ?? '').replace(/\s+/g, ' ').trim()]
    .filter(Boolean)
    .join(' ')
    .slice(0, 200);
}

/**
 * @param {unknown} v
 * @param {number} [max]
 * @param {number} [itemMax]
 */
function cleanStrList(v, max = 40, itemMax = 200) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    const s = cleanStr(item, itemMax);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeKinds(raw) {
  const fromArray = Array.isArray(raw?.kinds)
    ? raw.kinds
    : Array.isArray(raw)
      ? raw
      : null;
  if (fromArray) {
    const out = [];
    for (const k of fromArray) {
      let s = cleanStr(k, 40).toLowerCase();
      if (s === 'self') {
        if (!out.includes('friend')) out.push('friend');
        continue;
      }
      // Legacy: "kids" was briefly a contact kind — migrated to hasKids.
      if (s === 'kids' || s === 'kid') continue;
      if (s === 'community' || s === 'scene' || s === 'orgainzer') s = 'organizer';
      if ((s === 'friend' || s === 'organizer' || s === 'business') && !out.includes(s)) {
        out.push(s);
      }
    }
    return out.length ? out : ['friend'];
  }
  const legacy = cleanStr(raw?.kind ?? raw, 40).toLowerCase();
  if (legacy === 'business') return ['business'];
  if (legacy === 'kids' || legacy === 'kid') return ['friend'];
  if (legacy === 'community' || legacy === 'scene' || legacy === 'organizer' || legacy === 'orgainzer') {
    return ['organizer'];
  }
  if (legacy === 'friend' || legacy === 'self' || !legacy) return ['friend'];
  return ['friend'];
}

/**
 * @returns {string}
 */
export function newContactTaskId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Normalize contact task checklist. Migrates legacy `nextStep` string into one open task.
 * @param {unknown} raw
 * @returns {{ id: string, text: string, done: boolean }[]}
 */
export function normalizeTasks(raw) {
  if (!raw || typeof raw !== 'object') return [];
  /** @type {{ id: string, text: string, done: boolean }[]} */
  const out = [];
  const seen = new Set();
  const pushTask = (id, text, done) => {
    const t = cleanStr(text, 500);
    if (!t) return;
    const key = `${done ? '1' : '0'}:${t.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: cleanStr(id, 80) || newContactTaskId(),
      text: t,
      done: Boolean(done),
    });
  };

  if (Array.isArray(raw.tasks)) {
    for (const item of raw.tasks) {
      if (!item || typeof item !== 'object') {
        if (typeof item === 'string') pushTask('', item, false);
        continue;
      }
      pushTask(item.id, item.text ?? item.title ?? item.label, item.done);
      if (out.length >= 40) break;
    }
  }

  // Legacy free-text nextStep → open task(s), one per line / semicolon.
  const legacy = cleanStr(raw.nextStep, 2000);
  if (legacy && !out.some((t) => !t.done)) {
    const chunks = legacy
      .split(/\n+|;/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const chunk of chunks) {
      pushTask('', chunk, false);
      if (out.length >= 40) break;
    }
  }

  return out;
}

/**
 * True when the contact has at least one incomplete task.
 * @param {unknown} contact
 */
export function contactHasOpenTask(contact) {
  const tasks = Array.isArray(contact?.tasks) ? contact.tasks : normalizeTasks(contact || {});
  return tasks.some((t) => t && !t.done && String(t.text || '').trim());
}

/**
 * Open-task titles joined for search / legacy nextStep display.
 * @param {{ id?: string, text?: string, done?: boolean }[]} tasks
 */
export function openTasksSummary(tasks) {
  if (!Array.isArray(tasks)) return '';
  return tasks
    .filter((t) => t && !t.done && String(t.text || '').trim())
    .map((t) => String(t.text).trim())
    .join('; ')
    .slice(0, 2000);
}

/**
 * Whether the contact has kids. Separate from Type (friend/organizer/business).
 * Migrates legacy `kinds: ['kids']` / `kind: 'kids'`.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function normalizeHasKids(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(raw, 'hasKids')) {
    const v = raw.hasKids;
    if (v === true || v === 1) return true;
    if (v === false || v === 0 || v == null || v === '') return false;
    const s = String(v).trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'y' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === 'n' || s === '0') return false;
  }
  const kinds = Array.isArray(raw.kinds) ? raw.kinds : [];
  for (const k of kinds) {
    const s = cleanStr(k, 40).toLowerCase();
    if (s === 'kids' || s === 'kid') return true;
  }
  const legacy = cleanStr(raw.kind, 40).toLowerCase();
  return legacy === 'kids' || legacy === 'kid';
}

/**
 * @param {unknown} methods
 */
function normalizePreferredMethods(methods) {
  const allowed = new Set(PREFERRED_CONTACT_METHODS);
  const list = Array.isArray(methods) ? methods : [];
  const out = [];
  for (const m of list) {
    const s = cleanStr(m, 40).toLowerCase().replace(/\s+/g, '_');
    if (!allowed.has(s) || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

/**
 * @param {unknown} channels
 */
function normalizeChannels(channels) {
  const c = channels && typeof channels === 'object' ? channels : {};
  const urls = cleanStrList(c.urls, 20);
  return {
    email: cleanStr(c.email, 320) || null,
    phone: cleanStr(c.phone, 80) || null,
    officePhone: cleanStr(c.officePhone ?? c.office_phone, 80) || null,
    sms: cleanStr(c.sms, 80) || null,
    signal: cleanStr(c.signal, 120) || null,
    whatsapp: cleanStr(c.whatsapp, 120) || null,
    telegram: cleanStr(c.telegram, 120) || null,
    linkedin: cleanStr(c.linkedin, 500) || null,
    other: cleanStr(c.other, 320) || null,
    urls,
  };
}

/**
 * @param {unknown} v
 * @param {string[]} allowed
 */
function cleanEnum(v, allowed) {
  const s = cleanStr(v, 80);
  if (!s) return '';
  for (const a of allowed) {
    if (a.toLowerCase() === s.toLowerCase()) return a;
  }
  return '';
}

/**
 * Map relationshipStatus, migrating legacy lifecycleStatus / old enums when needed.
 * @param {object} raw
 */
function normalizeRelationshipStatus(raw) {
  const direct = cleanEnum(raw.relationshipStatus, CONTACT_RELATIONSHIP_STATUSES);
  if (direct) return direct;

  const legacyVal = cleanStr(raw.relationshipStatus || raw.lifecycleStatus, 80).toLowerCase();
  if (!legacyVal) return '';

  /** @type {Record<string, string>} */
  const legacyMap = {
    lead: 'Lead',
    active: 'Collaborator',
    cultivating: 'Cultivating',
    collaborator: 'Collaborator',
    family: 'Family',
    polyfam: 'Family',
    'inner circle': 'Inner Circle',
    innercircle: 'Inner Circle',
    acquaintance: 'Acquaintance',
    aquaintance: 'Acquaintance',
    dormant: 'Paused',
    paused: 'Paused',
    retired: 'Former',
    former: 'Former',
  };
  if (legacyMap[legacyVal]) return legacyMap[legacyVal];
  return cleanEnum(raw.lifecycleStatus, CONTACT_RELATIONSHIP_STATUSES);
}

/**
 * @param {unknown} enrichment
 */
function normalizeEnrichment(enrichment) {
  const e = enrichment && typeof enrichment === 'object' ? enrichment : {};
  let confidence = null;
  if (typeof e.confidence === 'number' && Number.isFinite(e.confidence)) {
    confidence = Math.max(0, Math.min(1, e.confidence));
  } else if (e.confidence != null && e.confidence !== '') {
    const n = Number(e.confidence);
    if (Number.isFinite(n)) confidence = Math.max(0, Math.min(1, n));
  }
  return {
    sources: cleanStrList(e.sources, 30),
    enrichedAt: cleanStr(e.enrichedAt, 64) || null,
    rawSummary: cleanStr(e.rawSummary, 4000) || null,
    confidence,
    needsReview: Boolean(e.needsReview),
    lastMode: cleanStr(e.lastMode, 80) || null,
  };
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeContact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = remapLegacyNetworkId(cleanStr(raw.id, 80) || newContactId());
  const rawFirst = cleanStr(raw.firstName, 120);
  const rawLast = cleanStr(raw.lastName, 120);
  let displayName;
  let firstName;
  let lastName;
  if (rawFirst || rawLast) {
    firstName = titleCaseGivenName(rawFirst);
    lastName = titleCaseWord(rawLast);
    displayName = normalizeContactDisplayName(composeDisplayName(firstName, lastName), (s) => s);
  } else {
    displayName = normalizeContactDisplayName(raw.displayName, titleCaseName);
    const parts = splitPersonName(displayName);
    firstName = parts.firstName;
    lastName = parts.lastName;
  }
  const kinds = normalizeKinds(raw);
  const hasKids = normalizeHasKids(raw);
  let summary = cleanStr(raw.summary, 8000);
  if (!summary && Array.isArray(raw.tags) && raw.tags.length) {
    summary = cleanStrList(raw.tags, 40).join(' ');
  }
  const now = new Date().toISOString();
  let source = cleanStr(raw.source, 40) || 'manual';
  if (source === 'seed') source = 'manual';
  // Prefer location; fold legacy region into empty location, then drop region.
  let locationSeed = cleanStr(raw.location, 300);
  if (!locationSeed) locationSeed = cleanStr(raw.region, 300);
  const { networkCircles, location } = relocateOutOfTownFromScenes(
    raw.networkCircles,
    locationSeed,
    4000,
    300,
  );
  const tasks = normalizeTasks(raw);
  return {
    id,
    displayName,
    firstName,
    lastName,
    nickname: titleCaseName(cleanStr(raw.nickname, 120)),
    memoryJog: cleanStr(raw.memoryJog, 80),
    aliases: cleanStrList(raw.aliases, 20).map(titleCaseName),
    kinds,
    hasKids,
    summary,
    notes: cleanStr(raw.notes, 8000),
    bio: cleanStr(raw.bio, 8000),
    howWeMet: cleanStr(raw.howWeMet, 4000),
    networkCircles,
    alignedActivities: cleanStrList(raw.alignedActivities, 60, 400),
    org: cleanStr(raw.org, 300),
    orgId: raw.orgId ? remapLegacyNetworkId(cleanStr(raw.orgId, 80)) : null,
    title: cleanStr(raw.title, 300),
    department: cleanStr(raw.department, 300),
    location,
    address: cleanStr(raw.address, 500),
    rating: (() => {
      const legacy = cleanStr(raw.rating, 80).toLowerCase();
      if (legacy === 'ride or die') return 'Fan';
      return cleanEnum(raw.rating, CONTACT_RATINGS);
    })(),
    sensitivity: cleanEnum(raw.sensitivity, CONTACT_SENSITIVITIES),
    relationshipStatus: normalizeRelationshipStatus(raw),
    tasks,
    // Derived from open tasks for search / older callers; not a primary edit field.
    nextStep: openTasksSummary(tasks),
    preferredContactMethods: normalizePreferredMethods(raw.preferredContactMethods),
    channels: normalizeChannels(raw.channels),
    avatarUrl: cleanStr(raw.avatarUrl, 500) || null,
    ...normalizeLastContactFields(raw.lastContactAt, raw.lastContactPrecision),
    lastContactChannel: cleanStr(raw.lastContactChannel, 80) || null,
    enrichment: normalizeEnrichment(raw.enrichment),
    createdAt: cleanStr(raw.createdAt, 64) || now,
    updatedAt: cleanStr(raw.updatedAt, 64) || now,
    source,
  };
}

/**
 * System-only unique contact id (decimal string). Not shown in the People UI.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function newContactId(env = process.env) {
  return allocateNextContactId(openNetworkDb(env));
}

/**
 * @returns {Promise<{ version: number, contacts: object[] }>}
 */
export async function loadNetworkContacts(env = process.env) {
  const db = openNetworkDb(env);
  const rows = db
    .prepare('SELECT id, display_name, org, payload, created_at, updated_at FROM contacts ORDER BY created_at ASC, id ASC')
    .all();
  const contacts = rows.map((r) => normalizeContact(rowToContact(r))).filter(Boolean);
  return { version: 1, contacts };
}

/**
 * @deprecated no-op — SQLite writes per mutation
 */
export async function saveNetworkContacts(_data, _env = process.env) {
  /* no-op */
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function getContactById(id, env = process.env) {
  const db = openNetworkDb(env);
  const want = remapLegacyNetworkId(id);
  const row = db
    .prepare('SELECT id, display_name, org, payload, created_at, updated_at FROM contacts WHERE id = ?')
    .get(want);
  if (!row) return null;
  return normalizeContact(rowToContact(row));
}

/**
 * @param {object} contact
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function addContact(contact, env = process.env) {
  let payload = { ...contact };
  const orgName = cleanStr(payload?.org, 300);
  if (orgName) {
    try {
      const { ensureOrganizationByName } = await import('./network-organizations-store.js');
      const org = await ensureOrganizationByName(orgName, env);
      if (org) {
        payload.org = org.name;
        payload.orgId = org.id;
      }
    } catch {
      // ignore
    }
  }
  const normalized = normalizeContact({
    ...payload,
    id: payload?.id || newContactId(),
    createdAt: payload?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  if (!normalized) {
    const err = new Error('invalid_contact');
    err.code = 'invalid_contact';
    throw err;
  }

  try {
    const { absorbContactIfDuplicate } = await import('./network-dedup.js');
    const absorbed = await absorbContactIfDuplicate(normalized, env);
    if (absorbed?.contact) return absorbed.contact;
  } catch {
    // Dedup is best-effort — still create the contact.
  }

  const db = openNetworkDb(env);
  upsertContactRow(db, normalized);
  return normalized;
}

/**
 * @param {unknown} names
 * @param {{ kinds?: string[], preferredContactMethods?: string[], hasKids?: boolean }} [defaults]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function addContactsBulk(names, defaults = {}, env = process.env) {
  /** @type {string[]} */
  let list = [];
  if (Array.isArray(names)) {
    list = names.map((n) => cleanStr(n, 200)).filter(Boolean);
  } else {
    list = String(names || '')
      .split(/\n+/)
      .map((n) => cleanStr(n, 200))
      .filter(Boolean);
  }
  const seen = new Set();
  list = list.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!list.length) {
    const err = new Error('names_required');
    err.code = 'names_required';
    throw err;
  }

  const kinds = normalizeKinds({ kinds: defaults.kinds || ['friend'] });
  const hasKids = Boolean(defaults.hasKids);
  const preferredContactMethods = normalizePreferredMethods(defaults.preferredContactMethods || []);
  const db = openNetworkDb(env);
  const { contacts } = await loadNetworkContacts(env);
  const existingNames = new Set(
    contacts.flatMap((c) => [
      String(c.displayName || '').toLowerCase(),
      String(c.nickname || '').toLowerCase(),
      ...(c.aliases || []).map((a) => String(a).toLowerCase()),
    ].filter(Boolean)),
  );

  const created = [];
  let absorbed = 0;
  const { absorbContactIfDuplicate } = await import('./network-dedup.js');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const displayName of list) {
      if (existingNames.has(displayName.toLowerCase())) continue;
      const normalized = normalizeContact({
        displayName,
        kinds,
        hasKids,
        preferredContactMethods,
        source: 'manual',
      });
      if (!normalized) continue;
      try {
        const hit = await absorbContactIfDuplicate(normalized, env);
        if (hit?.contact) {
          absorbed += 1;
          existingNames.add(displayName.toLowerCase());
          for (const a of hit.contact.aliases || []) existingNames.add(String(a).toLowerCase());
          existingNames.add(String(hit.contact.displayName || '').toLowerCase());
          continue;
        }
      } catch {
        // fall through to create
      }
      upsertContactRow(db, normalized);
      existingNames.add(displayName.toLowerCase());
      created.push(normalized);
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
  return { created, skipped: list.length - created.length - absorbed, absorbed };
}

/**
 * @param {string} id
 * @param {object} patch
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function updateContact(id, patch, env = process.env) {
  const prev = await getContactById(id, env);
  if (!prev) return null;
  const merged = {
    ...prev,
    ...(patch && typeof patch === 'object' ? patch : {}),
    id: prev.id,
    channels: {
      ...prev.channels,
      ...(patch?.channels && typeof patch.channels === 'object' ? patch.channels : {}),
    },
    enrichment: {
      ...prev.enrichment,
      ...(patch?.enrichment && typeof patch.enrichment === 'object' ? patch.enrichment : {}),
    },
    updatedAt: new Date().toISOString(),
  };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'kinds')) {
    merged.kinds = patch.kinds;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'preferredContactMethods')) {
    merged.preferredContactMethods = patch.preferredContactMethods;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'alignedActivities')) {
    merged.alignedActivities = patch.alignedActivities;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'tasks')) {
    merged.tasks = patch.tasks;
    // Prefer explicit tasks list over a stale nextStep string in the same patch.
    if (!Object.prototype.hasOwnProperty.call(patch, 'nextStep')) {
      delete merged.nextStep;
    }
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'summary')) {
    merged.summary = patch.summary;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'howWeMet')) {
    merged.howWeMet = patch.howWeMet;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'networkCircles')) {
    merged.networkCircles = patch.networkCircles;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'orgId')) {
    merged.orgId = patch.orgId;
  }

  if (patch && Object.prototype.hasOwnProperty.call(patch, 'lastContactAt')) {
    const raw = String(patch.lastContactAt ?? '').trim();
    if (!raw) {
      merged.lastContactAt = null;
      merged.lastContactPrecision = null;
    } else {
      const { parseLastContactInput } = await import('./network-last-contact.js');
      const looksIso = /^\d{4}-\d{2}-\d{2}T/.test(raw);
      const prec = patch.lastContactPrecision === 'month' || patch.lastContactPrecision === 'day'
        ? patch.lastContactPrecision
        : null;
      if (looksIso && prec) {
        const ms = Date.parse(raw);
        if (!Number.isNaN(ms)) {
          merged.lastContactAt = new Date(ms).toISOString();
          merged.lastContactPrecision = prec;
        }
      } else {
        const parsed = parseLastContactInput(raw);
        if (parsed) {
          merged.lastContactAt = parsed.iso;
          merged.lastContactPrecision = parsed.precision;
        } else {
          // Mid-typing / unrecognized — keep prior stamp so autosave doesn't wipe it.
          merged.lastContactAt = prev.lastContactAt;
          merged.lastContactPrecision = prev.lastContactPrecision;
        }
      }
    }
  }

  const orgName = cleanStr(merged.org, 300);
  if (orgName) {
    try {
      const { ensureOrganizationByName } = await import('./network-organizations-store.js');
      const org = await ensureOrganizationByName(orgName, env);
      if (org) {
        merged.org = org.name;
        merged.orgId = org.id;
      }
    } catch {
      // ignore
    }
  } else if (patch && Object.prototype.hasOwnProperty.call(patch, 'org') && !orgName) {
    merged.org = '';
    merged.orgId = null;
  }

  // When only displayName changes, clear first/last so normalize re-splits
  // (middle names stay on firstName). When first/last change, prefer those.
  if (
    patch
    && Object.prototype.hasOwnProperty.call(patch, 'displayName')
    && !Object.prototype.hasOwnProperty.call(patch, 'firstName')
    && !Object.prototype.hasOwnProperty.call(patch, 'lastName')
  ) {
    delete merged.firstName;
    delete merged.lastName;
  }
  if (
    patch
    && (Object.prototype.hasOwnProperty.call(patch, 'firstName')
      || Object.prototype.hasOwnProperty.call(patch, 'lastName'))
    && !Object.prototype.hasOwnProperty.call(patch, 'displayName')
  ) {
    merged.displayName = composeDisplayName(
      Object.prototype.hasOwnProperty.call(patch, 'firstName') ? patch.firstName : prev.firstName,
      Object.prototype.hasOwnProperty.call(patch, 'lastName') ? patch.lastName : prev.lastName,
    );
  }

  const normalized = normalizeContact(merged);
  if (!normalized) {
    const err = new Error('invalid_contact');
    err.code = 'invalid_contact';
    throw err;
  }
  upsertContactRow(openNetworkDb(env), normalized);

  try {
    const { dedupeContactAfterSave } = await import('./network-dedup.js');
    const result = await dedupeContactAfterSave(normalized, env);
    if (result?.contact) return result.contact;
  } catch {
    // Dedup is best-effort.
  }
  return normalized;
}

/**
 * @param {string[]} ids
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function deleteContacts(ids, env = process.env) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map((id) => remapLegacyNetworkId(String(id))))].filter(
    Boolean,
  );
  if (!want.length) return { deleted: 0 };
  const db = openNetworkDb(env);
  const stmt = db.prepare('DELETE FROM contacts WHERE id = ?');
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    removeContactRefs(db, want);
    for (const id of want) {
      const info = stmt.run(id);
      deleted += Number(info.changes) || 0;
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
  return { deleted };
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function findContactByNameOrAlias(name, env = process.env) {
  const needle = cleanStr(name, 200).toLowerCase();
  if (!needle) return null;
  const { contacts } = await loadNetworkContacts(env);
  for (const c of contacts) {
    if (String(c.displayName || '').toLowerCase() === needle) return c;
    if (String(c.nickname || '').toLowerCase() === needle) return c;
    if ((c.aliases || []).some((a) => String(a).toLowerCase() === needle)) return c;
  }
  return null;
}

/**
 * @param {{ displayName: string, aliases?: string[], notes?: string, kinds?: string[], kind?: string, org?: string, title?: string, channels?: object, summary?: string, alignedActivities?: string[] }} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function upsertFromTelegram(payload, env = process.env) {
  const name = cleanStr(payload?.displayName, 200);
  if (!name) {
    const err = new Error('displayName_required');
    err.code = 'displayName_required';
    throw err;
  }
  const existing = await findContactByNameOrAlias(name, env);
  const noteLine = cleanStr(payload?.notes, 2000);
  const kinds = normalizeKinds(payload);
  const summaryBits = [payload?.summary, 'telegram'].filter(Boolean).map((s) => cleanStr(s, 200));
  const location = cleanStr(payload?.location, 300);
  const address = cleanStr(payload?.address, 500);
  const channelUrls = [
    ...cleanStrList(payload?.channels?.urls, 20),
    cleanStr(payload?.website, 500),
  ].filter(Boolean);
  const channelsIn = {
    ...(payload.channels && typeof payload.channels === 'object' ? payload.channels : {}),
    urls: channelUrls.length
      ? [...new Set([...(payload.channels?.urls || []), ...channelUrls])].slice(0, 20)
      : payload.channels?.urls,
  };
  const preferredFromChannels = preferredMethodsForFilledChannels(
    { ...(existing?.channels || {}), ...channelsIn },
    existing?.preferredContactMethods,
  );

  if (existing) {
    const notes = [existing.notes, noteLine].filter(Boolean).join('\n\n').slice(0, 8000);
    const aliases = [...new Set([...(existing.aliases || []), ...(payload.aliases || [])])];
    const summary = [existing.summary, ...summaryBits].filter(Boolean).join(' ').slice(0, 8000);
    return updateContact(
      existing.id,
      {
        notes,
        aliases,
        summary,
        kinds: kinds.length ? kinds : existing.kinds,
        org: cleanStr(payload.org, 300) || existing.org,
        title: cleanStr(payload.title, 300) || existing.title,
        location: location || existing.location,
        address: address || existing.address,
        // Default Telegram intakes to Lead when relationship is still blank.
        ...(!String(existing.relationshipStatus || '').trim()
          ? { relationshipStatus: 'Lead' }
          : {}),
        channels: { ...existing.channels, ...channelsIn },
        preferredContactMethods: preferredFromChannels,
        lastContactAt: new Date().toISOString(),
        lastContactChannel: 'telegram',
        source: 'telegram',
      },
      env,
    );
  }
  return addContact(
    {
      displayName: name,
      aliases: payload.aliases || [],
      notes: noteLine,
      summary: summaryBits.join(' '),
      kinds,
      org: payload.org || '',
      title: payload.title || '',
      location: location || '',
      address: address || '',
      relationshipStatus: 'Lead',
      channels: channelsIn,
      preferredContactMethods: preferredFromChannels,
      lastContactAt: new Date().toISOString(),
      lastContactChannel: 'telegram',
      source: 'telegram',
    },
    env,
  );
}

/**
 * Prefer methods for any channel that already has a value (so CRM fields show after Telegram ingest).
 * @param {object} channels
 * @param {unknown} [existingPrefs]
 */
function preferredMethodsForFilledChannels(channels, existingPrefs) {
  const c = channels && typeof channels === 'object' ? channels : {};
  /** @type {Record<string, string>} */
  const map = {
    phone: 'phone',
    officePhone: 'office_phone',
    email: 'email',
    signal: 'signal',
    whatsapp: 'whatsapp',
    linkedin: 'linkedin',
    other: 'other',
  };
  const out = new Set(normalizePreferredMethods(existingPrefs));
  for (const [chKey, pref] of Object.entries(map)) {
    if (cleanStr(c[chKey], 500)) out.add(pref);
  }
  return [...out];
}

/**
 * @param {Buffer} buf
 * @param {string} basename
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveNetworkAsset(buf, basename, env = process.env) {
  const dir = networkAssetsDir(env);
  await fs.mkdir(dir, { recursive: true });
  const safe = String(basename || 'asset').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  const fp = path.join(dir, safe);
  await fs.writeFile(fp, buf);
  return `/api/network/assets/${safe}`;
}

/**
 * @param {string} contactId
 * @param {{ dataUrl?: string, base64?: string, mimeType?: string }} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveContactAvatar(contactId, payload, env = process.env) {
  const contact = await getContactById(contactId, env);
  if (!contact) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }

  let mime = cleanStr(payload?.mimeType, 80).toLowerCase() || 'image/jpeg';
  let b64 = String(payload?.base64 || '').trim();
  const dataUrl = String(payload?.dataUrl || '').trim();
  if (dataUrl.startsWith('data:')) {
    const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!m) {
      const err = new Error('invalid_image');
      err.code = 'invalid_image';
      throw err;
    }
    mime = m[1].toLowerCase();
    b64 = m[2];
  }
  if (!b64) {
    const err = new Error('invalid_image');
    err.code = 'invalid_image';
    throw err;
  }

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    const err = new Error('invalid_image');
    err.code = 'invalid_image';
    throw err;
  }
  if (buf.length < 32 || buf.length > 8_000_000) {
    const err = new Error('invalid_image_size');
    err.code = 'invalid_image_size';
    throw err;
  }

  let ext = '.jpg';
  if (mime.includes('png')) ext = '.png';
  else if (mime.includes('webp')) ext = '.webp';
  else if (mime.includes('gif')) ext = '.gif';

  const avatarUrl = await saveNetworkAsset(buf, `${contactId}-avatar${ext}`, env);
  return updateContact(contactId, { avatarUrl }, env);
}
