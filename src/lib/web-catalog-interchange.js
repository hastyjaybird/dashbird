/**
 * Shared interchange helpers for catalog ↔ climate-dash data_sources.
 */
export const INTERCHANGE_VERSION = 1;

/**
 * @param {string} url
 */
export function normalizeCatalogUrl(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('url_required');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_url');
  parsed.hash = '';
  // Strip trailing slash except for root
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }
  return parsed.toString();
}

/**
 * @param {string} url
 */
export function canonicalHost(url) {
  try {
    return new URL(normalizeCatalogUrl(url)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * @param {object[]} resources
 * @param {object} [filter]
 * @param {string} [source]
 */
export function buildExportBundle(resources, filter = {}, source = 'web-catalog') {
  return {
    version: INTERCHANGE_VERSION,
    exported_at: new Date().toISOString(),
    source,
    filter,
    resources: (resources || []).map((r) => ({
      url: r.url,
      title: r.title || '',
      summary: r.summary || '',
      tags: Array.isArray(r.tags) ? r.tags : [],
      kind_hints: Array.isArray(r.kind_hints) ? r.kind_hints : [],
      proficient: Boolean(r.proficient),
      watch_enabled: Boolean(r.watch_enabled),
      watch_mode: r.watch_mode || 'off',
      ingest_candidate: Boolean(r.ingest_candidate),
      operating_systems: Array.isArray(r.operating_systems) ? r.operating_systems : [],
      icon_path: r.icon_path || r.logo_url || null,
    })),
  };
}

/**
 * @param {unknown} raw
 */
export function parseImportBundle(raw) {
  const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!j || typeof j !== 'object') throw new Error('invalid_bundle');
  const version = Number(j.version) || 0;
  if (version !== INTERCHANGE_VERSION) throw new Error(`unsupported_version:${version}`);
  const resources = Array.isArray(j.resources) ? j.resources : [];
  return {
    version,
    exported_at: j.exported_at || null,
    source: String(j.source || ''),
    filter: j.filter && typeof j.filter === 'object' ? j.filter : {},
    resources,
  };
}

/**
 * Map catalog resource → climate-dash data_sources insert shape (no id).
 * @param {object} r
 */
export function toDataSourceRow(r) {
  const kinds = Array.isArray(r.kind_hints) ? r.kind_hints : [];
  const source_type = kinds.includes('feed') ? 'rss' : 'web';
  return {
    name: String(r.title || r.url || 'Untitled').slice(0, 200),
    url: normalizeCatalogUrl(r.url),
    source_type,
    keywords: Array.isArray(r.tags) ? r.tags : [],
    active: false,
    preflight_status: 'pending',
    status: 'pending',
  };
}
