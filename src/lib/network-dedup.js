/**
 * Automatic fuzzy dedup for network contacts (people) and organizations (companies).
 *
 * Contact info matches (email, phone, LinkedIn, website) are near-certain.
 * Shared display names alone are not enough for people (common names); companies
 * treat exact/near name as much stronger. Soft fields (org, title, location)
 * raise likelihood when names are already similar.
 */
import {
  ALL_POWER_LABS_ORG_ID,
  CORVIDAE_ORG_ID,
  JULIA_CONTACT_ID,
  openNetworkDb,
  remapLegacyNetworkId,
  rowToContact,
  rowToGroup,
  SAM_CONTACT_ID,
  STARSHOT_ORG_ID,
  upsertContactRow,
  upsertGroupRow,
  upsertOrgRow,
} from './network-db.js';

/** @type {Set<string>} */
const PROTECTED_CONTACT_IDS = new Set([JULIA_CONTACT_ID, SAM_CONTACT_ID]);
/** @type {Set<string>} */
const PROTECTED_ORG_IDS = new Set([CORVIDAE_ORG_ID, ALL_POWER_LABS_ORG_ID, STARSHOT_ORG_ID]);

/** Auto-merge when likelihood reaches this (0–1). */
export const CONTACT_MERGE_THRESHOLD = 0.72;
export const ORG_MERGE_THRESHOLD = 0.78;

/** People need at least this name/alias similarity unless a hard identifier matches. */
const CONTACT_NAME_GATE = 0.55;

/** Reentrancy guard — merge calls update paths that would re-enter dedup. */
let dedupDepth = 0;

/**
 * @param {unknown} v
 * @param {number} [max]
 */
function cleanStr(v, max = 2000) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.slice(0, max);
}

/**
 * @param {string} a
 * @param {string} b
 */
function levenshtein(a, b) {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const rows = s.length + 1;
  const cols = t.length + 1;
  /** @type {number[]} */
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    /** @type {number[]} */
    const cur = [i];
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

/**
 * @param {string} a
 * @param {string} b
 */
export function stringSimilarity(a, b) {
  const s = cleanStr(a, 500).toLowerCase();
  const t = cleanStr(b, 500).toLowerCase();
  if (!s || !t) return 0;
  if (s === t) return 1;
  const maxLen = Math.max(s.length, t.length);
  if (!maxLen) return 0;
  return Math.max(0, 1 - levenshtein(s, t) / maxLen);
}

/**
 * @param {string} name
 */
function nameTokens(name) {
  return cleanStr(name, 300)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t.length >= 2);
}

/** Corporate legal suffixes — strip before comparing company names. */
const ORG_SUFFIX_RE =
  /\b(incorporated|corporation|company|limited|llc|llp|l\.?l\.?c\.?|inc|corp|ltd|co|plc|gmbh|ag|sa|pty)\b\.?/gi;

/**
 * @param {string} name
 */
function normalizeOrgNameCore(name) {
  return cleanStr(name, 300)
    .replace(ORG_SUFFIX_RE, ' ')
    .replace(/[.,/#'"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Token Jaccard + string similarity blend for person/company names.
 * @param {string} a
 * @param {string} b
 * @param {{ org?: boolean }} [opts]
 */
export function nameSimilarity(a, b, opts = {}) {
  let sa = cleanStr(a, 300);
  let sb = cleanStr(b, 300);
  if (!sa || !sb) return 0;
  if (opts.org) {
    sa = normalizeOrgNameCore(sa) || sa;
    sb = normalizeOrgNameCore(sb) || sb;
  }
  const exact = stringSimilarity(sa, sb);
  const ta = nameTokens(sa);
  const tb = nameTokens(sb);
  if (!ta.length || !tb.length) return exact;
  const setB = new Set(tb);
  let inter = 0;
  for (const t of ta) if (setB.has(t)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = union ? inter / union : 0;
  // Initials: "J Hasty" vs "Julia Hasty"
  let initialBoost = 0;
  if (!opts.org && ta.length >= 2 && tb.length >= 2) {
    const aFirst = ta[0];
    const bFirst = tb[0];
    const aLast = ta[ta.length - 1];
    const bLast = tb[tb.length - 1];
    if (aLast === bLast && (aFirst === bFirst || aFirst[0] === bFirst[0])) {
      initialBoost = 0.15;
    }
  }
  return Math.min(1, Math.max(exact, jaccard * 0.85 + exact * 0.15) + initialBoost);
}

/**
 * @param {string | null | undefined} email
 */
function normalizeEmail(email) {
  const s = cleanStr(email, 320).toLowerCase();
  return s.includes('@') ? s : '';
}

/**
 * Digits-only phone; strip leading 1 for NA numbers when 11 digits.
 * @param {string | null | undefined} phone
 */
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  if (digits.length < 7) return '';
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

/**
 * @param {string | null | undefined} url
 */
function normalizeUrl(url) {
  let s = cleanStr(url, 500).toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  s = s.split('?')[0].split('#')[0];
  return s;
}

/**
 * LinkedIn profile path key (linkedin.com/in/slug).
 * @param {string | null | undefined} url
 */
function normalizeLinkedin(url) {
  const n = normalizeUrl(url);
  if (!n) return '';
  const m = n.match(/(?:^|\.)linkedin\.com\/(?:in|company|school)\/([^/?#]+)/);
  if (m) return `linkedin:${m[1].replace(/\/+$/, '')}`;
  if (!n.includes('/') && !n.includes('.')) return `linkedin:${n}`;
  return n.includes('linkedin') ? n : '';
}

/**
 * @param {object} channels
 * @returns {string[]}
 */
function contactHardKeys(channels) {
  const c = channels && typeof channels === 'object' ? channels : {};
  /** @type {string[]} */
  const keys = [];
  const email = normalizeEmail(c.email);
  if (email) keys.push(`email:${email}`);
  for (const field of ['phone', 'sms', 'whatsapp']) {
    const p = normalizePhone(c[field]);
    if (p) keys.push(`phone:${p}`);
  }
  const signal = cleanStr(c.signal, 120).toLowerCase();
  if (signal) keys.push(`signal:${signal}`);
  const li = normalizeLinkedin(c.linkedin);
  if (li) keys.push(li);
  for (const u of Array.isArray(c.urls) ? c.urls : []) {
    const n = normalizeUrl(u);
    if (n) keys.push(`url:${n}`);
  }
  return [...new Set(keys)];
}

/**
 * @param {object} org
 * @returns {string[]}
 */
function orgHardKeys(org) {
  /** @type {string[]} */
  const keys = [];
  const web = normalizeUrl(org?.website);
  if (web) keys.push(`web:${web}`);
  for (const u of Array.isArray(org?.urls) ? org.urls : []) {
    const n = normalizeUrl(u);
    if (n) keys.push(`url:${n}`);
  }
  return [...new Set(keys)];
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function sharedKeys(a, b) {
  const setB = new Set(b);
  return a.filter((k) => setB.has(k));
}

/**
 * All name/alias strings for a contact.
 * @param {object} contact
 */
function contactNamePool(contact) {
  const names = [cleanStr(contact?.displayName, 200), ...(Array.isArray(contact?.aliases) ? contact.aliases : [])]
    .map((n) => cleanStr(n, 200))
    .filter(Boolean);
  return [...new Set(names.map((n) => n.toLowerCase()))].map((n) =>
    names.find((x) => x.toLowerCase() === n) || n,
  );
}

/**
 * @param {object} org
 */
function orgNamePool(org) {
  const names = [cleanStr(org?.name, 300), ...(Array.isArray(org?.aliases) ? org.aliases : [])]
    .map((n) => cleanStr(n, 300))
    .filter(Boolean);
  return [...new Set(names.map((n) => n.toLowerCase()))].map((n) =>
    names.find((x) => x.toLowerCase() === n) || n,
  );
}

/**
 * Best pairwise name similarity across two name pools.
 * @param {string[]} poolA
 * @param {string[]} poolB
 * @param {{ org?: boolean }} [opts]
 */
function bestNameSimilarity(poolA, poolB, opts = {}) {
  let best = 0;
  for (const a of poolA) {
    for (const b of poolB) {
      best = Math.max(best, nameSimilarity(a, b, opts));
      if (best >= 1) return 1;
    }
  }
  return best;
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {{ score: number, hardMatch: boolean, reasons: string[], nameScore: number }}
 */
export function scoreContactPair(a, b) {
  if (!a || !b || a.id === b.id) {
    return { score: 0, hardMatch: false, reasons: [], nameScore: 0 };
  }

  const hard = sharedKeys(contactHardKeys(a.channels), contactHardKeys(b.channels));
  const nameScore = bestNameSimilarity(contactNamePool(a), contactNamePool(b));
  /** @type {string[]} */
  const reasons = [];

  if (hard.length) {
    reasons.push(`hard:${hard[0]}`);
    // Hard identifier match is near-certain even when names differ (maiden name, nickname).
    return { score: 0.97, hardMatch: true, reasons, nameScore };
  }

  if (nameScore < CONTACT_NAME_GATE) {
    return { score: 0, hardMatch: false, reasons: ['name_too_different'], nameScore };
  }

  let score = 0;
  if (nameScore >= 0.98) {
    score += 0.38;
    reasons.push('name_exact');
  } else if (nameScore >= 0.85) {
    score += 0.28;
    reasons.push('name_close');
  } else if (nameScore >= 0.7) {
    score += 0.18;
    reasons.push('name_similar');
  } else {
    score += 0.1;
    reasons.push('name_weak');
  }

  const orgIdA = a.orgId ? remapLegacyNetworkId(String(a.orgId)) : '';
  const orgIdB = b.orgId ? remapLegacyNetworkId(String(b.orgId)) : '';
  if (orgIdA && orgIdB && orgIdA === orgIdB) {
    score += 0.22;
    reasons.push('same_org_id');
  } else {
    const orgA = cleanStr(a.org, 300).toLowerCase();
    const orgB = cleanStr(b.org, 300).toLowerCase();
    if (orgA && orgB && (orgA === orgB || nameSimilarity(orgA, orgB) >= 0.9)) {
      score += 0.16;
      reasons.push('same_org_name');
    }
  }

  const titleA = cleanStr(a.title, 300);
  const titleB = cleanStr(b.title, 300);
  if (titleA && titleB) {
    const ts = nameSimilarity(titleA, titleB);
    if (ts >= 0.95) {
      score += 0.16;
      reasons.push('same_title');
    } else if (ts >= 0.75) {
      score += 0.1;
      reasons.push('similar_title');
    }
  }

  const locA = cleanStr(a.location, 300).toLowerCase();
  const locB = cleanStr(b.location, 300).toLowerCase();
  if (locA && locB && (locA === locB || stringSimilarity(locA, locB) >= 0.85)) {
    score += 0.08;
    reasons.push('same_location');
  }

  const kindsA = new Set((a.kinds || []).map((k) => String(k).toLowerCase()));
  const kindsB = (b.kinds || []).map((k) => String(k).toLowerCase());
  if (kindsA.size && kindsB.some((k) => kindsA.has(k))) {
    score += 0.03;
    reasons.push('kinds_overlap');
  }

  return {
    score: Math.min(1, score),
    hardMatch: false,
    reasons,
    nameScore,
  };
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {{ score: number, hardMatch: boolean, reasons: string[], nameScore: number }}
 */
export function scoreOrgPair(a, b) {
  if (!a || !b || a.id === b.id) {
    return { score: 0, hardMatch: false, reasons: [], nameScore: 0 };
  }

  const hard = sharedKeys(orgHardKeys(a), orgHardKeys(b));
  const nameScore = bestNameSimilarity(orgNamePool(a), orgNamePool(b), { org: true });
  /** @type {string[]} */
  const reasons = [];

  if (hard.length) {
    reasons.push(`hard:${hard[0]}`);
    return { score: 0.98, hardMatch: true, reasons, nameScore };
  }

  let score = 0;
  // Companies rarely share exact names — exact/near name is strong evidence.
  if (nameScore >= 0.98) {
    score += 0.82;
    reasons.push('name_exact');
  } else if (nameScore >= 0.88) {
    score += 0.78;
    reasons.push('name_close');
  } else if (nameScore >= 0.75) {
    score += 0.62;
    reasons.push('name_similar');
  } else if (nameScore >= 0.6) {
    score += 0.35;
    reasons.push('name_weak');
  } else {
    return { score: 0, hardMatch: false, reasons: ['name_too_different'], nameScore };
  }

  const locA = cleanStr(a.location, 300).toLowerCase();
  const locB = cleanStr(b.location, 300).toLowerCase();
  if (locA && locB && (locA === locB || stringSimilarity(locA, locB) >= 0.85)) {
    score += 0.12;
    reasons.push('same_location');
  }

  return {
    score: Math.min(1, score),
    hardMatch: false,
    reasons,
    nameScore,
  };
}

/**
 * @param {{ score: number, hardMatch: boolean }} verdict
 * @param {number} threshold
 */
export function shouldMerge(verdict, threshold) {
  if (!verdict) return false;
  if (verdict.hardMatch) return true;
  return Number(verdict.score) >= threshold;
}

/**
 * Prefer protected foundation ids, then older, then richer records.
 * @param {object} a
 * @param {object} b
 * @param {Set<string>} protectedIds
 */
function pickSurvivor(a, b, protectedIds) {
  const aProt = protectedIds.has(a.id);
  const bProt = protectedIds.has(b.id);
  if (aProt && !bProt) return { keep: a, drop: b };
  if (bProt && !aProt) return { keep: b, drop: a };

  const aCreated = Date.parse(a.createdAt || '') || Number.MAX_SAFE_INTEGER;
  const bCreated = Date.parse(b.createdAt || '') || Number.MAX_SAFE_INTEGER;
  if (aCreated !== bCreated) {
    return aCreated <= bCreated ? { keep: a, drop: b } : { keep: b, drop: a };
  }

  const richness = (x) => JSON.stringify(x || {}).length;
  return richness(a) >= richness(b) ? { keep: a, drop: b } : { keep: b, drop: a };
}

/**
 * @param {unknown} listA
 * @param {unknown} listB
 * @param {number} [max]
 */
function unionStrList(listA, listB, max = 40) {
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(listA) ? listA : []), ...(Array.isArray(listB) ? listB : [])]) {
    const s = cleanStr(item, 500);
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
 * Prefer non-empty; if both set and different, keep `preferred` then append other into notes-style fields separately.
 * @param {string} preferred
 * @param {string} other
 */
function preferStr(preferred, other) {
  const a = cleanStr(preferred, 8000);
  const b = cleanStr(other, 8000);
  if (a) return a;
  return b;
}

/**
 * @param {string} a
 * @param {string} b
 * @param {number} [max]
 */
function joinUniqueText(a, b, max = 8000) {
  const sa = cleanStr(a, max);
  const sb = cleanStr(b, max);
  if (!sa) return sb;
  if (!sb) return sa;
  if (sa.toLowerCase() === sb.toLowerCase()) return sa;
  if (sa.toLowerCase().includes(sb.toLowerCase())) return sa;
  if (sb.toLowerCase().includes(sa.toLowerCase())) return sb;
  return `${sa}\n\n${sb}`.slice(0, max);
}

/**
 * Build merged contact payload (keep.id preserved).
 * @param {object} keep
 * @param {object} drop
 */
export function buildMergedContact(keep, drop) {
  const aliases = unionStrList(
    [...(keep.aliases || []), keep.displayName !== drop.displayName ? drop.displayName : null],
    drop.aliases,
    20,
  ).filter((a) => a.toLowerCase() !== String(keep.displayName || '').toLowerCase());

  const channels = {
    email: preferStr(keep.channels?.email, drop.channels?.email) || null,
    phone: preferStr(keep.channels?.phone, drop.channels?.phone) || null,
    sms: preferStr(keep.channels?.sms, drop.channels?.sms) || null,
    signal: preferStr(keep.channels?.signal, drop.channels?.signal) || null,
    whatsapp: preferStr(keep.channels?.whatsapp, drop.channels?.whatsapp) || null,
    linkedin: preferStr(keep.channels?.linkedin, drop.channels?.linkedin) || null,
    urls: unionStrList(keep.channels?.urls, drop.channels?.urls, 20),
  };

  const lastA = Date.parse(keep.lastContactAt || '') || 0;
  const lastB = Date.parse(drop.lastContactAt || '') || 0;
  const useDropLast = lastB > lastA;

  return {
    ...keep,
    aliases,
    kinds: unionStrList(keep.kinds, drop.kinds, 10),
    summary: joinUniqueText(keep.summary, drop.summary, 8000),
    notes: joinUniqueText(keep.notes, drop.notes, 8000),
    bio: preferStr(keep.bio, drop.bio) || joinUniqueText(keep.bio, drop.bio, 8000),
    howWeMet: preferStr(keep.howWeMet, drop.howWeMet),
    networkCircles: joinUniqueText(keep.networkCircles, drop.networkCircles, 4000).replace(/\n\n/g, ', '),
    alignedActivities: unionStrList(keep.alignedActivities, drop.alignedActivities, 60),
    org: preferStr(keep.org, drop.org),
    orgId: keep.orgId || drop.orgId || null,
    title: preferStr(keep.title, drop.title),
    location: preferStr(keep.location, drop.location),
    preferredContactMethods: unionStrList(keep.preferredContactMethods, drop.preferredContactMethods, 20),
    channels,
    avatarUrl: keep.avatarUrl || drop.avatarUrl || null,
    lastContactAt: useDropLast ? drop.lastContactAt : keep.lastContactAt,
    lastContactChannel: useDropLast ? drop.lastContactChannel : keep.lastContactChannel,
    enrichment: {
      sources: unionStrList(keep.enrichment?.sources, drop.enrichment?.sources, 30),
      enrichedAt: preferStr(keep.enrichment?.enrichedAt, drop.enrichment?.enrichedAt) || null,
      rawSummary: preferStr(keep.enrichment?.rawSummary, drop.enrichment?.rawSummary) || null,
    },
    createdAt: keep.createdAt || drop.createdAt,
    updatedAt: new Date().toISOString(),
    source: keep.source || drop.source || 'manual',
  };
}

/**
 * @param {object} keep
 * @param {object} drop
 */
export function buildMergedOrganization(keep, drop) {
  const aliases = unionStrList(
    [...(keep.aliases || []), keep.name !== drop.name ? drop.name : null],
    drop.aliases,
    20,
  ).filter((a) => a.toLowerCase() !== String(keep.name || '').toLowerCase());

  const suggestedMap = new Map();
  for (const p of [...(keep.suggestedPeople || []), ...(drop.suggestedPeople || [])]) {
    if (!p || typeof p !== 'object') continue;
    const key = cleanStr(p.name, 300).toLowerCase();
    if (!key) continue;
    const prev = suggestedMap.get(key);
    if (!prev) {
      suggestedMap.set(key, p);
      continue;
    }
    const rank = { added: 3, pending: 2, dismissed: 1 };
    const prevR = rank[prev.status] || 0;
    const nextR = rank[p.status] || 0;
    if (nextR > prevR) suggestedMap.set(key, { ...prev, ...p });
    else suggestedMap.set(key, { ...p, ...prev });
  }

  return {
    ...keep,
    aliases,
    summary: joinUniqueText(keep.summary, drop.summary, 8000),
    description: preferStr(keep.description, drop.description) || joinUniqueText(keep.description, drop.description, 8000),
    website: preferStr(keep.website, drop.website) || null,
    location: preferStr(keep.location, drop.location),
    urls: unionStrList(keep.urls, drop.urls, 20),
    logoUrl: keep.logoUrl || drop.logoUrl || null,
    suggestedPeople: [...suggestedMap.values()].slice(0, 40),
    enrichment: {
      sources: unionStrList(keep.enrichment?.sources, drop.enrichment?.sources, 30),
      enrichedAt: preferStr(keep.enrichment?.enrichedAt, drop.enrichment?.enrichedAt) || null,
      rawSummary: preferStr(keep.enrichment?.rawSummary, drop.enrichment?.rawSummary) || null,
    },
    createdAt: keep.createdAt || drop.createdAt,
    updatedAt: new Date().toISOString(),
    source: keep.source || drop.source || 'manual',
  };
}

/**
 * @param {string} fromId
 * @param {string} toId
 * @param {NodeJS.ProcessEnv} [env]
 */
function remapContactReferences(fromId, toId, env = process.env) {
  const db = openNetworkDb(env);
  const from = remapLegacyNetworkId(fromId);
  const to = remapLegacyNetworkId(toId);
  if (!from || !to || from === to) return;

  db.prepare('UPDATE notes SET contact_id = ? WHERE contact_id = ?').run(to, from);

  const groups = db.prepare('SELECT id, name, payload, created_at, updated_at FROM groups').all();
  for (const row of groups) {
    const g = rowToGroup(row);
    const members = Array.isArray(g.memberIds) ? g.memberIds : [];
    if (!members.includes(from)) continue;
    const memberIds = [...new Set(members.map((id) => (remapLegacyNetworkId(id) === from ? to : remapLegacyNetworkId(id))))];
    upsertGroupRow(db, {
      ...g,
      memberIds,
      updatedAt: new Date().toISOString(),
    });
  }
}

/**
 * @param {string} fromOrgId
 * @param {string} toOrgId
 * @param {NodeJS.ProcessEnv} [env]
 */
function remapOrganizationReferences(fromOrgId, toOrgId, env = process.env) {
  const db = openNetworkDb(env);
  const from = remapLegacyNetworkId(fromOrgId);
  const to = remapLegacyNetworkId(toOrgId);
  if (!from || !to || from === to) return;

  const rows = db
    .prepare('SELECT id, display_name, org, payload, created_at, updated_at FROM contacts')
    .all();
  for (const row of rows) {
    const c = rowToContact(row);
    const orgId = c.orgId ? remapLegacyNetworkId(String(c.orgId)) : null;
    if (orgId !== from) continue;
    const updated = {
      ...c,
      orgId: to,
      updatedAt: new Date().toISOString(),
    };
    upsertContactRow(db, updated);
  }
}

/**
 * @param {object} contact
 * @param {object[]} candidates
 * @param {number} [threshold]
 */
export function findBestContactMatch(contact, candidates, threshold = CONTACT_MERGE_THRESHOLD) {
  let best = null;
  for (const other of candidates || []) {
    if (!other || other.id === contact.id) continue;
    const verdict = scoreContactPair(contact, other);
    if (!shouldMerge(verdict, threshold)) continue;
    if (!best || verdict.score > best.verdict.score) {
      best = { candidate: other, verdict };
    }
  }
  return best;
}

/**
 * @param {object} org
 * @param {object[]} candidates
 * @param {number} [threshold]
 */
export function findBestOrgMatch(org, candidates, threshold = ORG_MERGE_THRESHOLD) {
  let best = null;
  for (const other of candidates || []) {
    if (!other || other.id === org.id) continue;
    const verdict = scoreOrgPair(org, other);
    if (!shouldMerge(verdict, threshold)) continue;
    if (!best || verdict.score > best.verdict.score) {
      best = { candidate: other, verdict };
    }
  }
  return best;
}

/**
 * Merge two contacts: keep survivor, delete duplicate, remap refs.
 * @param {object} a
 * @param {object} b
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ contact: object, mergedFromId: string, verdict: object }>}
 */
export async function mergeContacts(a, b, env = process.env) {
  const { normalizeContact } = await import('./network-contacts-store.js');
  const { keep, drop } = pickSurvivor(a, b, PROTECTED_CONTACT_IDS);

  const verdict = scoreContactPair(keep, drop);
  const mergedRaw = buildMergedContact(keep, drop);
  const normalized = normalizeContact(mergedRaw);
  if (!normalized) {
    const err = new Error('invalid_contact_merge');
    err.code = 'invalid_contact_merge';
    throw err;
  }

  const db = openNetworkDb(env);
  const dropExists = Boolean(
    db.prepare('SELECT 1 AS ok FROM contacts WHERE id = ?').get(drop.id),
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    upsertContactRow(db, normalized);
    if (dropExists) {
      remapContactReferences(drop.id, keep.id, env);
      db.prepare('DELETE FROM contacts WHERE id = ?').run(drop.id);
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

  return { contact: normalized, mergedFromId: drop.id, verdict };
}

/**
 * @param {object} a
 * @param {object} b
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function mergeOrganizations(a, b, env = process.env) {
  const { normalizeOrganization } = await import('./network-organizations-store.js');
  const { keep, drop } = pickSurvivor(a, b, PROTECTED_ORG_IDS);

  const verdict = scoreOrgPair(keep, drop);
  const mergedRaw = buildMergedOrganization(keep, drop);
  const normalized = normalizeOrganization(mergedRaw);
  if (!normalized) {
    const err = new Error('invalid_organization_merge');
    err.code = 'invalid_organization_merge';
    throw err;
  }

  const db = openNetworkDb(env);
  const dropExists = Boolean(
    db.prepare('SELECT 1 AS ok FROM organizations WHERE id = ?').get(drop.id),
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    upsertOrgRow(db, normalized);
    if (dropExists) {
      remapOrganizationReferences(drop.id, keep.id, env);
      const rows = db
        .prepare('SELECT id, display_name, org, payload, created_at, updated_at FROM contacts')
        .all();
      const dropName = cleanStr(drop.name, 300).toLowerCase();
      for (const row of rows) {
        const c = rowToContact(row);
        const orgId = c.orgId ? remapLegacyNetworkId(String(c.orgId)) : null;
        const orgName = cleanStr(c.org, 300).toLowerCase();
        if (orgId !== keep.id && orgName !== dropName) continue;
        upsertContactRow(db, {
          ...c,
          org: normalized.name,
          orgId: keep.id,
          updatedAt: new Date().toISOString(),
        });
      }
      db.prepare('DELETE FROM organizations WHERE id = ?').run(drop.id);
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

  return { organization: normalized, mergedFromId: drop.id, verdict };
}

/**
 * Find an existing contact this record should merge into (before insert).
 * @param {object} contact
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function findContactDuplicate(contact, env = process.env) {
  const { loadNetworkContacts } = await import('./network-contacts-store.js');
  const { contacts } = await loadNetworkContacts(env);
  return findBestContactMatch(contact, contacts);
}

/**
 * @param {object} org
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function findOrganizationDuplicate(org, env = process.env) {
  const { loadNetworkOrganizations } = await import('./network-organizations-store.js');
  const { organizations } = await loadNetworkOrganizations(env);
  return findBestOrgMatch(org, organizations);
}

/**
 * After save: if a high-likelihood duplicate exists, merge and return survivor.
 * @param {object} contact
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ contact: object, didMerge: boolean, mergedFromId?: string, verdict?: object }>}
 */
export async function dedupeContactAfterSave(contact, env = process.env) {
  if (!contact?.id || dedupDepth > 0) {
    return { contact, didMerge: false };
  }
  dedupDepth += 1;
  try {
    const match = await findContactDuplicate(contact, env);
    if (!match) return { contact, didMerge: false };
    const result = await mergeContacts(contact, match.candidate, env);
    return {
      contact: result.contact,
      didMerge: true,
      mergedFromId: result.mergedFromId,
      verdict: result.verdict,
    };
  } finally {
    dedupDepth -= 1;
  }
}

/**
 * @param {object} org
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function dedupeOrganizationAfterSave(org, env = process.env) {
  if (!org?.id || dedupDepth > 0) {
    return { organization: org, didMerge: false };
  }
  dedupDepth += 1;
  try {
    const match = await findOrganizationDuplicate(org, env);
    if (!match) return { organization: org, didMerge: false };
    const result = await mergeOrganizations(org, match.candidate, env);
    return {
      organization: result.organization,
      didMerge: true,
      mergedFromId: result.mergedFromId,
      verdict: result.verdict,
    };
  } finally {
    dedupDepth -= 1;
  }
}

/**
 * Before create: if duplicate exists, merge incoming fields into the existing row (no new id).
 * @param {object} incomingNormalized
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function absorbContactIfDuplicate(incomingNormalized, env = process.env) {
  if (!incomingNormalized || dedupDepth > 0) return null;
  dedupDepth += 1;
  try {
    const match = await findContactDuplicate(incomingNormalized, env);
    if (!match) return null;
    const { normalizeContact } = await import('./network-contacts-store.js');
    const existing = match.candidate;
    const donor = { ...incomingNormalized, id: existing.id };
    const normalized = normalizeContact(buildMergedContact(existing, donor));
    if (!normalized) return null;
    upsertContactRow(openNetworkDb(env), normalized);
    return {
      contact: normalized,
      didMerge: true,
      mergedFromId: incomingNormalized.id || null,
      verdict: match.verdict,
      absorbed: true,
    };
  } finally {
    dedupDepth -= 1;
  }
}

/**
 * @param {object} incomingNormalized
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function absorbOrganizationIfDuplicate(incomingNormalized, env = process.env) {
  if (!incomingNormalized || dedupDepth > 0) return null;
  dedupDepth += 1;
  try {
    const match = await findOrganizationDuplicate(incomingNormalized, env);
    if (!match) return null;
    const { normalizeOrganization } = await import('./network-organizations-store.js');
    const existing = match.candidate;
    const donor = { ...incomingNormalized, id: existing.id };
    const normalized = normalizeOrganization(buildMergedOrganization(existing, donor));
    if (!normalized) return null;
    upsertOrgRow(openNetworkDb(env), normalized);
    return {
      organization: normalized,
      didMerge: true,
      mergedFromId: incomingNormalized.id || null,
      verdict: match.verdict,
      absorbed: true,
    };
  } finally {
    dedupDepth -= 1;
  }
}

/**
 * Full pairwise sweep — useful after imports. Merges greedily until no pairs remain.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function runNetworkDedupSweep(env = process.env) {
  if (dedupDepth > 0) {
    return { contactsMerged: 0, organizationsMerged: 0 };
  }
  dedupDepth += 1;
  let contactsMerged = 0;
  let organizationsMerged = 0;
  try {
    const { loadNetworkContacts } = await import('./network-contacts-store.js');
    const { loadNetworkOrganizations } = await import('./network-organizations-store.js');

    // Organizations first so contact orgId remaps stay coherent.
    let orgPass = true;
    while (orgPass) {
      orgPass = false;
      const { organizations } = await loadNetworkOrganizations(env);
      outer: for (let i = 0; i < organizations.length; i++) {
        for (let j = i + 1; j < organizations.length; j++) {
          const verdict = scoreOrgPair(organizations[i], organizations[j]);
          if (!shouldMerge(verdict, ORG_MERGE_THRESHOLD)) continue;
          await mergeOrganizations(organizations[i], organizations[j], env);
          organizationsMerged += 1;
          orgPass = true;
          break outer;
        }
      }
    }

    let contactPass = true;
    while (contactPass) {
      contactPass = false;
      const { contacts } = await loadNetworkContacts(env);
      outer: for (let i = 0; i < contacts.length; i++) {
        for (let j = i + 1; j < contacts.length; j++) {
          const verdict = scoreContactPair(contacts[i], contacts[j]);
          if (!shouldMerge(verdict, CONTACT_MERGE_THRESHOLD)) continue;
          await mergeContacts(contacts[i], contacts[j], env);
          contactsMerged += 1;
          contactPass = true;
          break outer;
        }
      }
    }
  } finally {
    dedupDepth -= 1;
  }
  return { contactsMerged, organizationsMerged };
}

/**
 * One-time background sweep for existing duplicates (meta flag `dedup_sweep_v1`).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ force?: boolean }} [opts]
 */
export async function scheduleNetworkDedupSweepOnce(env = process.env, opts = {}) {
  const db = openNetworkDb(env);
  const prev = db.prepare('SELECT value FROM meta WHERE key = ?').get('dedup_sweep_v1');
  if (!opts.force && prev && String(prev.value) === '1') {
    return { skipped: true, contactsMerged: 0, organizationsMerged: 0 };
  }
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run('dedup_sweep_v1', 'pending');
  const result = await runNetworkDedupSweep(env);
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run('dedup_sweep_v1', '1');
  return { skipped: false, ...result };
}
