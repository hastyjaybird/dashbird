/**
 * Web Resource Catalog store — local JSON by default; Supabase when configured.
 * Schema mirrors supabase/migrations/001_web_catalog.sql
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  forceWebCatalogLocal,
  getWebCatalogClient,
  isMissingCatalogSchemaError,
  webCatalogConfigured,
} from './web-catalog-client.js';

/**
 * If Supabase schema is missing, flip to local and return true so callers can retry.
 * @param {unknown} error
 */
function maybeFallbackToLocal(error) {
  if (!isMissingCatalogSchemaError(error)) return false;
  forceWebCatalogLocal(error?.message || error);
  return true;
}
import {
  buildExportBundle,
  canonicalHost,
  normalizeCatalogUrl,
  parseImportBundle,
} from './web-catalog-interchange.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export function webCatalogPath(env = process.env) {
  const override = String(env.WEB_CATALOG_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/web-catalog.json');
}

function emptyCatalog() {
  return {
    version: 1,
    resources: [],
    memberships: [],
    review_items: [],
    discovery_jobs: [],
  };
}

async function loadLocal() {
  const p = webCatalogPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw);
    return {
      version: Number(j?.version) || 1,
      resources: Array.isArray(j?.resources) ? j.resources : [],
      memberships: Array.isArray(j?.memberships) ? j.memberships : [],
      review_items: Array.isArray(j?.review_items) ? j.review_items : [],
      discovery_jobs: Array.isArray(j?.discovery_jobs) ? j.discovery_jobs : [],
    };
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return emptyCatalog();
    throw e;
  }
}

/** Serialize local catalog writes (same race as tool-library.json). */
let webCatalogWriteChain = Promise.resolve();

async function writeWebCatalogFile(data) {
  const p = webCatalogPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, p);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function saveLocal(data) {
  const next = webCatalogWriteChain.then(
    () => writeWebCatalogFile(data),
    () => writeWebCatalogFile(data),
  );
  webCatalogWriteChain = next.catch(() => {});
  await next;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {Partial<object>} input
 */
export function normalizeResourceInput(input = {}) {
  const url = normalizeCatalogUrl(input.url);
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  const kind_hints = Array.isArray(input.kind_hints)
    ? input.kind_hints.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  const operating_systems = Array.isArray(input.operating_systems)
    ? input.operating_systems.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  const watch_mode = ['off', 'updown', 'change'].includes(input.watch_mode)
    ? input.watch_mode
    : 'off';
  /** @type {Record<string, unknown>} */
  const out = {
    url,
    canonical_host: canonicalHost(url),
    title: String(input.title || '').trim() || url,
    summary: String(input.summary || '').trim(),
    kind_hints,
    tags,
    icon_path: input.icon_path || null,
    logo_url: input.logo_url || null,
    snapshot_url: input.snapshot_url || null,
    proficient: Boolean(input.proficient),
    watch_enabled: Boolean(input.watch_enabled) || watch_mode !== 'off',
    watch_mode: input.watch_enabled === false ? 'off' : watch_mode,
    last_status: input.last_status ?? null,
    last_checked_at: input.last_checked_at ?? null,
    last_changed_at: input.last_changed_at ?? null,
    content_fingerprint: input.content_fingerprint ?? null,
    ingest_candidate: Boolean(input.ingest_candidate),
    operating_systems,
    rating: input.rating ?? null,
    rating_source: input.rating_source || null,
    pricing: input.pricing && typeof input.pricing === 'object' ? input.pricing : {},
    features: Array.isArray(input.features) ? input.features : [],
    pros: Array.isArray(input.pros) ? input.pros : [],
    cons: Array.isArray(input.cons) ? input.cons : [],
    legacy_tool_id: input.legacy_tool_id || null,
  };
  // Only set favorite when explicitly provided so upserts do not clobber existing stars.
  if (Object.prototype.hasOwnProperty.call(input, 'favorite')) {
    out.favorite = Boolean(input.favorite);
  }
  return out;
}

/**
 * Tool Library card shape from a catalog resource.
 * @param {object} r
 */
export function resourceToToolRecord(r) {
  return {
    id: r.legacy_tool_id || r.id,
    catalogId: r.id,
    url: r.url,
    website: r.url,
    name: r.title,
    bestUsedFor: r.summary || '',
    pricing: r.pricing || { model: 'unknown', lowestTier: '', summary: '' },
    features: r.features || [],
    pros: r.pros || [],
    cons: r.cons || [],
    rating: r.rating ?? null,
    ratingSource: r.rating_source || '',
    operatingSystems: r.operating_systems || [],
    categories: r.tags?.length ? r.tags : (r.kind_hints || []).filter((k) => k !== 'tool'),
    tags: r.tags || [],
    kindHints: r.kind_hints || [],
    logoUrl: r.logo_url || r.icon_path || '',
    snapshotUrl: r.snapshot_url || '',
    addedAt: r.added_at || r.created_at,
    watchEnabled: Boolean(r.watch_enabled),
    watchMode: r.watch_mode || 'off',
    lastStatus: r.last_status || null,
    lastCheckedAt: r.last_checked_at || null,
    lastChangedAt: r.last_changed_at || null,
    ingestCandidate: Boolean(r.ingest_candidate),
    proficient: Boolean(r.proficient),
    favorite: Boolean(r.favorite),
  };
}

/**
 * @param {object} tool
 */
export function toolRecordToResource(tool) {
  const cats = Array.isArray(tool.categories) ? tool.categories : [];
  /** @type {Record<string, unknown>} */
  const base = {
    url: tool.url || tool.website,
    title: tool.name,
    summary: tool.bestUsedFor || '',
    kind_hints: ['tool', ...cats.filter((c) => !['tool'].includes(c))].slice(0, 8),
    tags: cats,
    logo_url: tool.logoUrl || null,
    snapshot_url: tool.snapshotUrl || null,
    operating_systems: tool.operatingSystems || [],
    rating: tool.rating,
    rating_source: tool.ratingSource,
    pricing: tool.pricing || {},
    features: tool.features || [],
    pros: tool.pros || [],
    cons: tool.cons || [],
    legacy_tool_id: tool.id || null,
    proficient: Boolean(tool.proficient),
  };
  if (Object.prototype.hasOwnProperty.call(tool, 'favorite')) {
    base.favorite = Boolean(tool.favorite);
  }
  return normalizeResourceInput(base);
}

function matchesFilters(r, q = {}) {
  if (q.project) {
    // memberships checked by caller for local; supabase uses join
  }
  if (q.ingest_candidate != null && Boolean(r.ingest_candidate) !== Boolean(q.ingest_candidate)) {
    return false;
  }
  if (q.proficient != null && Boolean(r.proficient) !== Boolean(q.proficient)) return false;
  if (q.favorite != null && Boolean(r.favorite) !== Boolean(q.favorite)) return false;
  if (q.watch_enabled != null && Boolean(r.watch_enabled) !== Boolean(q.watch_enabled)) {
    return false;
  }
  if (q.kind) {
    const kinds = r.kind_hints || [];
    if (!kinds.includes(q.kind)) return false;
  }
  if (q.tag) {
    const tags = r.tags || [];
    if (!tags.some((t) => t.toLowerCase() === String(q.tag).toLowerCase())) return false;
  }
  if (q.tags?.length) {
    const tags = (r.tags || []).map((t) => t.toLowerCase());
    if (!q.tags.some((t) => tags.includes(String(t).toLowerCase()))) return false;
  }
  if (q.search) {
    const blob = [r.title, r.summary, r.url, ...(r.tags || []), ...(r.kind_hints || [])]
      .join(' ')
      .toLowerCase();
    const tokens = String(q.search)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.every((t) => blob.includes(t))) return false;
  }
  return true;
}

function isMissingFavoriteColumnError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('favorite') && (msg.includes('column') || msg.includes('schema') || msg.includes('does not exist'));
}

/**
 * Upsert that tolerates missing migration 002 (favorite column).
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {object} row
 */
async function upsertWebResourceRow(sb, row) {
  let result = await sb.from('web_resources').upsert(row, { onConflict: 'url' }).select('*').single();
  if (result.error && isMissingFavoriteColumnError(result.error) && 'favorite' in row) {
    const { favorite: _fav, ...rest } = row;
    result = await sb.from('web_resources').upsert(rest, { onConflict: 'url' }).select('*').single();
  }
  return result;
}

/**
 * Update that tolerates missing migration 002 (favorite column).
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} id
 * @param {object} row
 */
async function updateWebResourceRow(sb, id, row) {
  let result = await sb.from('web_resources').update(row).eq('id', id).select('*').single();
  if (result.error && isMissingFavoriteColumnError(result.error) && 'favorite' in row) {
    const { favorite: _fav, ...rest } = row;
    result = await sb.from('web_resources').update(rest).eq('id', id).select('*').single();
  }
  return result;
}

export function catalogBackend() {
  return webCatalogConfigured() ? 'supabase' : 'local';
}

/** @param {object} [q] */
export async function listResources(q = {}) {
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      let query = sb.from('web_resources').select('*').order('title', { ascending: true });
      if (q.proficient != null) query = query.eq('proficient', Boolean(q.proficient));
      if (q.favorite != null) query = query.eq('favorite', Boolean(q.favorite));
      if (q.watch_enabled != null) query = query.eq('watch_enabled', Boolean(q.watch_enabled));
      if (q.ingest_candidate != null) {
        query = query.eq('ingest_candidate', Boolean(q.ingest_candidate));
      }
      if (q.kind) query = query.contains('kind_hints', [q.kind]);
      if (q.tag) query = query.contains('tags', [q.tag]);
      if (q.search) query = query.textSearch('search_vector', q.search, { type: 'websearch' });
      if (q.project) {
        const { data: mems, error: mErr } = await sb
          .from('project_memberships')
          .select('resource_id')
          .eq('project', q.project);
        if (mErr) throw mErr;
        const ids = (mems || []).map((m) => m.resource_id);
        if (!ids.length) return [];
        query = query.in('id', ids);
      }
      let { data, error } = await query;
      if (error && isMissingFavoriteColumnError(error) && q.favorite != null) {
        // Migration 002 not applied yet — drop favorite filter and continue.
        const retry = sb.from('web_resources').select('*').order('title', { ascending: true });
        // Rebuild without favorite (caller still gets all rows).
        let q2 = retry;
        if (q.proficient != null) q2 = q2.eq('proficient', Boolean(q.proficient));
        if (q.watch_enabled != null) q2 = q2.eq('watch_enabled', Boolean(q.watch_enabled));
        if (q.ingest_candidate != null) q2 = q2.eq('ingest_candidate', Boolean(q.ingest_candidate));
        if (q.kind) q2 = q2.contains('kind_hints', [q.kind]);
        if (q.tag) q2 = q2.contains('tags', [q.tag]);
        if (q.search) q2 = q2.textSearch('search_vector', q.search, { type: 'websearch' });
        if (q.project) {
          const { data: mems, error: mErr } = await sb
            .from('project_memberships')
            .select('resource_id')
            .eq('project', q.project);
          if (mErr) throw mErr;
          const ids = (mems || []).map((m) => m.resource_id);
          if (!ids.length) return [];
          q2 = q2.in('id', ids);
        }
        ({ data, error } = await q2);
      }
      if (error) throw error;
      return data || [];
    } catch (e) {
      if (maybeFallbackToLocal(e)) return listResources(q);
      throw e;
    }
  }

  const data = await loadLocal();
  let list = data.resources;
  if (q.project) {
    const ids = new Set(
      data.memberships.filter((m) => m.project === q.project).map((m) => m.resource_id),
    );
    list = list.filter((r) => ids.has(r.id));
  }
  return list.filter((r) => matchesFilters(r, q));
}

/** @param {string} id */
export async function getResourceById(id) {
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const { data, error } = await sb.from('web_resources').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
    } catch (e) {
      if (maybeFallbackToLocal(e)) return getResourceById(id);
      throw e;
    }
  }
  const data = await loadLocal();
  return data.resources.find((r) => r.id === id) || null;
}

/** @param {string} url */
export async function getResourceByUrl(url) {
  const normalized = normalizeCatalogUrl(url);
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const { data, error } = await sb
        .from('web_resources')
        .select('*')
        .eq('url', normalized)
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (e) {
      if (maybeFallbackToLocal(e)) return getResourceByUrl(url);
      throw e;
    }
  }
  const data = await loadLocal();
  return data.resources.find((r) => r.url === normalized) || null;
}

/**
 * @param {object} input
 * @param {{ project?: string, section?: string }} [membership]
 */
export async function upsertResource(input, membership = { project: 'dashbird' }) {
  const fields = normalizeResourceInput(input);
  const existing = await getResourceByUrl(fields.url);
  // Preserve existing favorite unless the caller explicitly set it.
  if (existing && !Object.prototype.hasOwnProperty.call(fields, 'favorite')) {
    fields.favorite = Boolean(existing.favorite);
  } else if (!Object.prototype.hasOwnProperty.call(fields, 'favorite')) {
    fields.favorite = false;
  }

  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const row = {
        ...fields,
        updated_at: nowIso(),
        ...(existing ? {} : { added_at: nowIso() }),
      };
      const { data, error } = await upsertWebResourceRow(sb, row);
      if (error) throw error;
      if (membership?.project) {
        await sb.from('project_memberships').upsert(
          {
            resource_id: data.id,
            project: membership.project,
            section: membership.section || null,
            sort_order: membership.sort_order || 0,
          },
          { onConflict: 'resource_id,project,section' },
        );
      }
      return data;
    } catch (e) {
      if (maybeFallbackToLocal(e)) return upsertResource(input, membership);
      throw e;
    }
  }

  const data = await loadLocal();
  const ts = nowIso();
  let resource;
  if (existing) {
    resource = {
      ...existing,
      ...fields,
      id: existing.id,
      favorite: fields.favorite,
      updated_at: ts,
      added_at: existing.added_at || ts,
    };
    data.resources = data.resources.map((r) => (r.id === existing.id ? resource : r));
  } else {
    resource = {
      id: randomUUID(),
      ...fields,
      favorite: fields.favorite,
      added_at: ts,
      created_at: ts,
      updated_at: ts,
    };
    data.resources.push(resource);
  }
  if (membership?.project) {
    const section = membership.section || null;
    const found = data.memberships.find(
      (m) =>
        m.resource_id === resource.id &&
        m.project === membership.project &&
        (m.section || null) === section,
    );
    if (!found) {
      data.memberships.push({
        id: randomUUID(),
        resource_id: resource.id,
        project: membership.project,
        section,
        sort_order: membership.sort_order || 0,
        created_at: ts,
      });
    }
  }
  await saveLocal(data);
  return resource;
}

/**
 * @param {string[]} ids
 * @param {{ urls?: string[], legacyToolIds?: string[] }} [extra]
 */
export async function deleteResources(ids, extra = {}) {
  const dropIds = new Set((ids || []).map(String).filter(Boolean));
  const dropLegacy = new Set((extra.legacyToolIds || []).map(String).filter(Boolean));
  const dropUrls = new Set();
  for (const u of extra.urls || []) {
    try {
      dropUrls.add(normalizeCatalogUrl(u));
    } catch {
      /* skip bad url */
    }
  }

  const matches = (r) =>
    dropIds.has(String(r.id)) ||
    (r.legacy_tool_id && dropLegacy.has(String(r.legacy_tool_id))) ||
    (r.url && dropUrls.has(r.url));

  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const all = await listResources({});
      const toDelete = all.filter(matches).map((r) => r.id);
      if (!toDelete.length) return { removed: 0 };
      const { error } = await sb.from('web_resources').delete().in('id', toDelete);
      if (error) throw error;
      return { removed: toDelete.length };
    } catch (e) {
      if (maybeFallbackToLocal(e)) return deleteResources(ids, extra);
      throw e;
    }
  }
  const data = await loadLocal();
  const before = data.resources.length;
  const keep = data.resources.filter((r) => !matches(r));
  const removedIds = new Set(
    data.resources.filter((r) => matches(r)).map((r) => r.id),
  );
  data.resources = keep;
  data.memberships = data.memberships.filter((m) => !removedIds.has(m.resource_id));
  await saveLocal(data);
  return { removed: before - data.resources.length };
}

/** @param {object} [filter] */
export async function exportResources(filter = {}) {
  const resources = await listResources(filter);
  return buildExportBundle(resources, filter, 'web-catalog');
}

/**
 * @param {unknown} raw
 * @param {{ project?: string, section?: string }} [membership]
 */
export async function importResources(raw, membership = { project: 'dashbird' }) {
  const bundle = parseImportBundle(raw);
  const added = [];
  for (const item of bundle.resources) {
    if (!item?.url) continue;
    try {
      const row = await upsertResource(item, membership);
      added.push(row);
    } catch (e) {
      console.warn('[web-catalog] import skip', item.url, e?.message || e);
    }
  }
  return { imported: added.length, resources: added, source: bundle.source };
}

export async function listReviewItems(status = 'pending') {
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      let q = sb.from('review_items').select('*').order('created_at', { ascending: false });
      if (status) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    } catch (e) {
      if (maybeFallbackToLocal(e)) return listReviewItems(status);
      throw e;
    }
  }
  const data = await loadLocal();
  return data.review_items.filter((r) => !status || r.status === status);
}

/**
 * Reject all pending review candidates so a new search does not mix with a prior one.
 * @returns {Promise<{ cleared: number }>}
 */
export async function clearPendingReviewItems() {
  const resolvedAt = nowIso();
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const { data: pending, error: listErr } = await sb
        .from('review_items')
        .select('id')
        .eq('status', 'pending');
      if (listErr) throw listErr;
      const ids = (pending || []).map((r) => r.id).filter(Boolean);
      if (!ids.length) return { cleared: 0 };
      const { error } = await sb
        .from('review_items')
        .update({ status: 'rejected', resolved_at: resolvedAt })
        .in('id', ids);
      if (error) throw error;
      return { cleared: ids.length };
    } catch (e) {
      if (maybeFallbackToLocal(e)) return clearPendingReviewItems();
      throw e;
    }
  }
  const data = await loadLocal();
  let cleared = 0;
  for (const item of data.review_items) {
    if (item.status !== 'pending') continue;
    item.status = 'rejected';
    item.resolved_at = resolvedAt;
    cleared += 1;
  }
  if (cleared) await saveLocal(data);
  return { cleared };
}

/**
 * @param {object} item
 */
/**
 * Pending review rows that collide with this candidate (same URL or same host+title).
 * @param {object[]} items
 * @param {{ candidate_url: string, candidate_title: string }} row
 */
function findPendingReviewDup(items, row) {
  const host = canonicalHost(row.candidate_url);
  const titleKey = String(row.candidate_title || '')
    .trim()
    .toLowerCase();
  return (items || []).find((r) => {
    if (r.status !== 'pending') return false;
    if (r.candidate_url === row.candidate_url) return true;
    if (host && canonicalHost(r.candidate_url) === host) {
      const otherTitle = String(r.candidate_title || '')
        .trim()
        .toLowerCase();
      if (!titleKey || !otherTitle || otherTitle === titleKey) return true;
    }
    return false;
  });
}

export async function addReviewItem(item) {
  const row = {
    id: randomUUID(),
    source_resource_id: item.source_resource_id || null,
    candidate_url: normalizeCatalogUrl(item.candidate_url),
    candidate_title: String(item.candidate_title || '').trim(),
    candidate_summary: String(item.candidate_summary || '').trim(),
    reason: String(item.reason || '').trim(),
    status: 'pending',
    payload: item.payload && typeof item.payload === 'object' ? item.payload : {},
    created_at: nowIso(),
    resolved_at: null,
  };
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const { data: pending, error: listErr } = await sb
        .from('review_items')
        .select('*')
        .eq('status', 'pending');
      if (listErr) throw listErr;
      const dup = findPendingReviewDup(pending || [], row);
      if (dup) return dup;
      const { data, error } = await sb.from('review_items').insert(row).select('*').single();
      if (error) throw error;
      return data;
    } catch (e) {
      if (maybeFallbackToLocal(e)) return addReviewItem(item);
      throw e;
    }
  }
  const data = await loadLocal();
  const dup = findPendingReviewDup(data.review_items, row);
  if (dup) return dup;
  data.review_items.push(row);
  await saveLocal(data);
  return row;
}

/**
 * @param {string} id
 * @param {'approved'|'rejected'} status
 */
export async function resolveReviewItem(id, status) {
  if (!['approved', 'rejected'].includes(status)) throw new Error('invalid_status');
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const { data: item, error: gErr } = await sb
        .from('review_items')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (gErr) throw gErr;
      if (!item) throw new Error('not_found');
      const { data, error } = await sb
        .from('review_items')
        .update({ status, resolved_at: nowIso() })
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      let resource = null;
      if (status === 'approved') {
        resource = await upsertResource(
          {
            url: item.candidate_url,
            title: item.candidate_title,
            summary: item.candidate_summary,
            kind_hints: item.payload?.kind_hints || ['tool'],
            tags: item.payload?.tags || [],
            logo_url: item.payload?.logo_url || null,
            snapshot_url: item.payload?.snapshot_url || null,
          },
          { project: 'dashbird' },
        );
      }
      return { item: data, resource };
    } catch (e) {
      if (maybeFallbackToLocal(e)) return resolveReviewItem(id, status);
      throw e;
    }
  }

  const data = await loadLocal();
  const item = data.review_items.find((r) => r.id === id);
  if (!item) throw new Error('not_found');
  item.status = status;
  item.resolved_at = nowIso();
  let resource = null;
  if (status === 'approved') {
    await saveLocal(data);
    resource = await upsertResource(
      {
        url: item.candidate_url,
        title: item.candidate_title,
        summary: item.candidate_summary,
        kind_hints: item.payload?.kind_hints || ['tool'],
        tags: item.payload?.tags || [],
        logo_url: item.payload?.logo_url || null,
        snapshot_url: item.payload?.snapshot_url || null,
      },
      { project: 'dashbird' },
    );
    return { item, resource };
  }
  await saveLocal(data);
  return { item, resource: null };
}

/**
 * @param {string} kind
 * @param {string|null} resourceId
 * @param {{ name?: string, url?: string }} [query] Ephemeral search context when resource is not in catalog yet.
 */
export async function createDiscoveryJob(kind, resourceId, query = null) {
  const qName = String(query?.name || '').trim();
  const qUrl = String(query?.url || '').trim();
  /** @type {Record<string, unknown>} */
  const result = {};
  if (qName || qUrl) {
    result._query = { name: qName, url: qUrl };
  }
  const row = {
    id: randomUUID(),
    kind: kind || 'alternatives',
    resource_id: resourceId || null,
    status: 'pending',
    error: null,
    result,
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
  };
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const { data, error } = await sb.from('discovery_jobs').insert(row).select('*').single();
      if (error) throw error;
      return data;
    } catch (e) {
      if (maybeFallbackToLocal(e)) return createDiscoveryJob(kind, resourceId, query);
      throw e;
    }
  }
  const data = await loadLocal();
  data.discovery_jobs.push(row);
  await saveLocal(data);
  return row;
}

export async function listDiscoveryJobs(limit = 20) {
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const { data, error } = await sb
        .from('discovery_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    } catch (e) {
      if (maybeFallbackToLocal(e)) return listDiscoveryJobs(limit);
      throw e;
    }
  }
  const data = await loadLocal();
  return data.discovery_jobs
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
}

export async function updateDiscoveryJob(id, patch) {
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const { data, error } = await sb
        .from('discovery_jobs')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data;
    } catch (e) {
      if (maybeFallbackToLocal(e)) return updateDiscoveryJob(id, patch);
      throw e;
    }
  }
  const data = await loadLocal();
  const job = data.discovery_jobs.find((j) => j.id === id);
  if (!job) throw new Error('not_found');
  Object.assign(job, patch);
  await saveLocal(data);
  return job;
}

export async function claimNextDiscoveryJob() {
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const { data: pending, error } = await sb
        .from('discovery_jobs')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) throw error;
      const job = pending?.[0];
      if (!job) return null;
      return updateDiscoveryJob(job.id, {
        status: 'running',
        started_at: nowIso(),
      });
    } catch (e) {
      if (maybeFallbackToLocal(e)) return claimNextDiscoveryJob();
      throw e;
    }
  }
  const data = await loadLocal();
  const job = data.discovery_jobs
    .filter((j) => j.status === 'pending')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
  if (!job) return null;
  job.status = 'running';
  job.started_at = nowIso();
  await saveLocal(data);
  return job;
}

/**
 * @param {string} id
 * @param {object} patch
 */
export async function patchResource(id, patch) {
  const current = await getResourceById(id);
  if (!current) throw new Error('not_found');
  const merged = normalizeResourceInput({ ...current, ...patch, url: patch.url || current.url });
  if (webCatalogConfigured()) {
    try {
      const sb = getWebCatalogClient();
      const { data, error } = await updateWebResourceRow(sb, id, {
        ...merged,
        updated_at: nowIso(),
      });
      if (error) throw error;
      return data;
    } catch (e) {
      if (maybeFallbackToLocal(e)) return patchResource(id, patch);
      throw e;
    }
  }
  const data = await loadLocal();
  const idx = data.resources.findIndex((r) => r.id === id);
  if (idx < 0) throw new Error('not_found');
  data.resources[idx] = {
    ...data.resources[idx],
    ...merged,
    id,
    updated_at: nowIso(),
  };
  await saveLocal(data);
  return data.resources[idx];
}

export async function collectTags(resources) {
  const set = new Set();
  for (const r of resources || []) {
    for (const t of r.tags || []) {
      const s = String(t || '').trim();
      if (s) set.add(s);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
