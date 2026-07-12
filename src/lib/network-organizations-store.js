/**
 * Network organizations — SQLite (data/network.db).
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ALL_POWER_LABS_ORG_ID,
  CORVIDAE_ORG_ID,
  openNetworkDb,
  remapLegacyNetworkId,
  rowToOrg,
  upsertOrgRow,
} from './network-db.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export { CORVIDAE_ORG_ID, ALL_POWER_LABS_ORG_ID };

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @deprecated JSON path unused
 */
export function networkOrganizationsPath(env = process.env) {
  const override = String(env.NETWORK_ORGANIZATIONS_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/network-organizations.json');
}

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

const ORG_TYPES = new Set(['Prospect', 'Customer', 'Partner', 'Competitor', 'Other']);
const ORG_RATINGS = new Set(['Hot', 'Warm', 'Cold']);
const ORG_LIFECYCLES = new Set(['Prospect', 'Qualified', 'Customer', 'Churned']);

/**
 * @param {unknown} v
 * @param {Set<string>} allowed
 */
function cleanEnum(v, allowed) {
  const s = cleanStr(v, 80);
  if (!s) return '';
  for (const a of allowed) {
    if (a.toLowerCase() === s.toLowerCase()) return a;
  }
  return s;
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
  };
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, name: string, title: string, linkedin: string | null, sourceUrl: string | null, status: string, foundAt: string }[]}
 */
export function normalizeSuggestedPeople(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = cleanStr(item.name, 300);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let status = cleanStr(item.status, 40) || 'pending';
    if (!['pending', 'dismissed', 'added'].includes(status)) status = 'pending';
    out.push({
      id: cleanStr(item.id, 80) || randomUUID(),
      name,
      title: cleanStr(item.title, 300),
      linkedin: cleanStr(item.linkedin, 500) || null,
      sourceUrl: cleanStr(item.sourceUrl, 500) || null,
      status,
      foundAt: cleanStr(item.foundAt, 64) || new Date().toISOString(),
    });
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeOrganization(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = remapLegacyNetworkId(cleanStr(raw.id, 80) || newOrgId());
  const name = cleanStr(raw.name, 300);
  const now = new Date().toISOString();
  let source = cleanStr(raw.source, 40) || 'manual';
  if (source === 'seed') source = 'manual';
  const type = cleanEnum(raw.type, ORG_TYPES);
  const rating = cleanEnum(raw.rating, ORG_RATINGS);
  const lifecycleStatus = cleanEnum(raw.lifecycleStatus, ORG_LIFECYCLES);
  return {
    id,
    name,
    aliases: cleanStrList(raw.aliases, 20),
    summary: cleanStr(raw.summary, 8000),
    description: cleanStr(raw.description, 8000),
    website: cleanStr(raw.website, 500) || null,
    location: cleanStr(raw.location, 300),
    region: cleanStr(raw.region, 300),
    type: ORG_TYPES.has(type) ? type : type || '',
    industry: cleanStr(raw.industry, 300),
    ownership: cleanStr(raw.ownership, 120),
    accountSource: cleanStr(raw.accountSource, 120),
    rating: ORG_RATINGS.has(rating) ? rating : '',
    annualRevenue: cleanStr(raw.annualRevenue, 120),
    employeeCount: cleanStr(raw.employeeCount, 80),
    fiscalYearEnd: cleanStr(raw.fiscalYearEnd, 80),
    competitiveNotes: cleanStr(raw.competitiveNotes, 8000),
    phone: cleanStr(raw.phone, 80),
    email: cleanStr(raw.email, 300),
    linkedin: cleanStr(raw.linkedin, 500) || null,
    socialUrls: cleanStrList(raw.socialUrls, 20, 500),
    locale: cleanStr(raw.locale, 80),
    primaryContactId: cleanStr(raw.primaryContactId, 80) || null,
    partnerRelationships: cleanStr(raw.partnerRelationships, 4000),
    lifecycleStatus: ORG_LIFECYCLES.has(lifecycleStatus) ? lifecycleStatus : '',
    nextStep: cleanStr(raw.nextStep, 2000),
    urls: cleanStrList(raw.urls, 20, 500),
    logoUrl: cleanStr(raw.logoUrl, 500) || null,
    suggestedPeople: normalizeSuggestedPeople(raw.suggestedPeople),
    enrichment: normalizeEnrichment(raw.enrichment),
    createdAt: cleanStr(raw.createdAt, 64) || now,
    updatedAt: cleanStr(raw.updatedAt, 64) || now,
    source,
  };
}

export function newOrgId() {
  return randomUUID();
}

/**
 * @returns {Promise<{ version: number, organizations: object[] }>}
 */
export async function loadNetworkOrganizations(env = process.env) {
  const db = openNetworkDb(env);
  const rows = db
    .prepare('SELECT id, name, payload, created_at, updated_at FROM organizations ORDER BY created_at ASC, name ASC')
    .all();
  return {
    version: 1,
    organizations: rows.map((r) => normalizeOrganization(rowToOrg(r))).filter(Boolean),
  };
}

/**
 * @deprecated no-op
 */
export async function saveNetworkOrganizations(_data, _env = process.env) {
  /* no-op */
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function getOrganizationById(id, env = process.env) {
  const db = openNetworkDb(env);
  const row = db
    .prepare('SELECT id, name, payload, created_at, updated_at FROM organizations WHERE id = ?')
    .get(remapLegacyNetworkId(id));
  if (!row) return null;
  return normalizeOrganization(rowToOrg(row));
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function findOrganizationByName(name, env = process.env) {
  const needle = cleanStr(name, 300).toLowerCase();
  if (!needle) return null;
  const { organizations } = await loadNetworkOrganizations(env);
  for (const o of organizations) {
    if (String(o.name || '').toLowerCase() === needle) return o;
    if ((o.aliases || []).some((a) => String(a).toLowerCase() === needle)) return o;
  }
  return null;
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function ensureOrganizationByName(name, env = process.env) {
  const clean = cleanStr(name, 300);
  if (!clean) return null;
  const existing = await findOrganizationByName(clean, env);
  if (existing) return existing;
  return addOrganization({ name: clean, source: 'manual' }, env);
}

/**
 * @param {object} org
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function addOrganization(org, env = process.env) {
  const normalized = normalizeOrganization({
    ...org,
    id: org?.id || newOrgId(),
    createdAt: org?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  if (!normalized) {
    const err = new Error('invalid_organization');
    err.code = 'invalid_organization';
    throw err;
  }

  try {
    const { absorbOrganizationIfDuplicate } = await import('./network-dedup.js');
    const absorbed = await absorbOrganizationIfDuplicate(normalized, env);
    if (absorbed?.organization) return absorbed.organization;
  } catch {
    // Dedup is best-effort — still create the organization.
  }

  upsertOrgRow(openNetworkDb(env), normalized);
  return normalized;
}

/**
 * @param {string} id
 * @param {object} patch
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function updateOrganization(id, patch, env = process.env) {
  const prev = await getOrganizationById(id, env);
  if (!prev) return null;
  const merged = {
    ...prev,
    ...(patch && typeof patch === 'object' ? patch : {}),
    id: prev.id,
    enrichment: {
      ...prev.enrichment,
      ...(patch?.enrichment && typeof patch.enrichment === 'object' ? patch.enrichment : {}),
    },
    updatedAt: new Date().toISOString(),
  };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'suggestedPeople')) {
    merged.suggestedPeople = patch.suggestedPeople;
  }
  const normalized = normalizeOrganization(merged);
  if (!normalized) {
    const err = new Error('invalid_organization');
    err.code = 'invalid_organization';
    throw err;
  }
  upsertOrgRow(openNetworkDb(env), normalized);

  try {
    const { dedupeOrganizationAfterSave } = await import('./network-dedup.js');
    const result = await dedupeOrganizationAfterSave(normalized, env);
    if (result?.organization) return result.organization;
  } catch {
    // Dedup is best-effort.
  }
  return normalized;
}

/**
 * @param {string[]} ids
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function deleteOrganizations(ids, env = process.env) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map((id) => remapLegacyNetworkId(String(id))))].filter(
    Boolean,
  );
  if (!want.length) return { deleted: 0 };
  const db = openNetworkDb(env);
  const stmt = db.prepare('DELETE FROM organizations WHERE id = ?');
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of want) {
      deleted += Number(stmt.run(id).changes) || 0;
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
