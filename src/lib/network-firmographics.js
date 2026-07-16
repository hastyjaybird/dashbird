/**
 * Structured firmographics for Network companies (employees + annual revenue).
 *
 * Free: Wikidata (P1128 / P2139) + SEC EDGAR companyfacts (US public filers).
 * Optional: Apollo Organization Enrichment (estimates — good for small / private cos).
 * Set APOLLO_API_KEY in .env (Apollo → Settings → Integrations → API).
 */
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const APOLLO_ORG_ENRICH = 'https://api.apollo.io/api/v1/organizations/enrich';
const SEC_UA = 'Dashbird/1.0 (personal CRM firmographics; local dashboard)';

/** @type {Promise<{ cik: string, ticker: string, title: string }[]> | null} */
let tickersCache = null;

/**
 * @param {unknown} v
 */
function cleanStr(v, max = 300) {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s.slice(0, max);
}

/**
 * @param {string} website
 */
export function websiteHost(website) {
  const raw = cleanStr(website, 500);
  if (!raw) return '';
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProto).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .toLowerCase();
  }
}

/**
 * @param {string} name
 */
function normalizeOrgName(name) {
  return cleanStr(name, 300)
    .toLowerCase()
    .replace(/[.,'"()]/g, ' ')
    .replace(
      /\b(incorporated|corporation|company|limited|llc|llp|inc|corp|ltd|co|plc|gmbh|ag|sa|pty|the)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {number} n
 */
function formatEmployeeCount(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const rounded = n >= 1000 ? Math.round(n) : Math.round(n * 10) / 10;
  return rounded.toLocaleString('en-US');
}

/**
 * @param {number} usd
 * @param {number} [fy]
 */
function formatUsdRevenue(usd, fy) {
  if (!Number.isFinite(usd) || usd <= 0) return '';
  const abs = Math.abs(usd);
  let core;
  if (abs >= 1e12) core = `$${(usd / 1e12).toFixed(abs >= 1e13 ? 0 : 1)}T`;
  else if (abs >= 1e9) core = `$${(usd / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  else if (abs >= 1e6) core = `$${(usd / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  else if (abs >= 1e3) core = `$${(usd / 1e3).toFixed(0)}K`;
  else core = `$${Math.round(usd).toLocaleString('en-US')}`;
  return fy ? `${core} (FY${fy})` : core;
}

/**
 * @param {string} unitUri
 */
function isUsdUnit(unitUri) {
  const u = String(unitUri || '');
  return u.endsWith('/Q4917') || u === 'http://www.wikidata.org/entity/Q4917' || u === '1';
}

/**
 * @param {object} claim
 */
function claimTime(claim) {
  const quals = claim?.qualifiers?.P585;
  if (!Array.isArray(quals) || !quals.length) return '';
  for (const q of quals) {
    const t = q?.datavalue?.value?.time;
    if (t) return String(t);
  }
  return '';
}

/**
 * @param {object} entity
 * @param {string} prop
 */
function bestQuantity(entity, prop) {
  const claims = entity?.claims?.[prop];
  if (!Array.isArray(claims)) return null;
  /** @type {{ amount: number, unit: string, when: string } | null} */
  let best = null;
  for (const claim of claims) {
    const snak = claim?.mainsnak;
    if (!snak || snak.snaktype !== 'value') continue;
    const dv = snak.datavalue?.value;
    const amount = Number(String(dv?.amount || '').replace(/^\+/, ''));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = String(dv?.unit || '1');
    const when = claimTime(claim);
    if (
      !best ||
      when > best.when ||
      (!best.when && when) ||
      (when === best.when && amount > best.amount)
    ) {
      best = { amount, unit, when };
    }
  }
  return best;
}

/**
 * @param {object} entity
 */
function entityOfficialWebsite(entity) {
  const claims = entity?.claims?.P856;
  if (!Array.isArray(claims)) return '';
  for (const claim of claims) {
    const v = claim?.mainsnak?.datavalue?.value;
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  return '';
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function fetchJson(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(18_000),
  });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json();
}

/**
 * @param {string} name
 * @param {string} [host]
 */
async function searchWikidataCandidates(name, host = '') {
  const q = cleanStr(name, 120) || host.split('.')[0] || '';
  if (!q) return [];
  const url =
    `${WIKIDATA_API}?` +
    new URLSearchParams({
      action: 'wbsearchentities',
      search: q,
      language: 'en',
      type: 'item',
      limit: '8',
      format: 'json',
      origin: '*',
    }).toString();
  const data = await fetchJson(url, {
    headers: { Accept: 'application/json', 'User-Agent': SEC_UA },
  });
  return Array.isArray(data?.search) ? data.search : [];
}

/**
 * @param {string[]} ids
 */
async function getWikidataEntities(ids) {
  const want = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 8);
  if (!want.length) return {};
  const url =
    `${WIKIDATA_API}?` +
    new URLSearchParams({
      action: 'wbgetentities',
      ids: want.join('|'),
      props: 'claims|labels|descriptions',
      languages: 'en',
      format: 'json',
      origin: '*',
    }).toString();
  const data = await fetchJson(url, {
    headers: { Accept: 'application/json', 'User-Agent': SEC_UA },
  });
  return data?.entities && typeof data.entities === 'object' ? data.entities : {};
}

/**
 * @param {{ name?: string, website?: string }} org
 * @param {object} entity
 * @param {string} searchLabel
 */
function scoreWikidataEntity(org, entity, searchLabel) {
  const host = websiteHost(org.website || '');
  const nameKey = normalizeOrgName(org.name || '');
  const label = normalizeOrgName(entity?.labels?.en?.value || searchLabel || '');
  const siteHost = websiteHost(entityOfficialWebsite(entity));
  let score = 0;
  if (host && siteHost) {
    if (host === siteHost) score += 100;
    else if (host.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${host}`)) score += 70;
    else return 0;
  }
  if (nameKey && label) {
    if (nameKey === label) score += 40;
    else if (nameKey.includes(label) || label.includes(nameKey)) score += 25;
    else {
      const a = new Set(nameKey.split(' ').filter(Boolean));
      const b = new Set(label.split(' ').filter(Boolean));
      let inter = 0;
      for (const t of a) if (b.has(t)) inter += 1;
      const union = a.size + b.size - inter || 1;
      score += Math.round((inter / union) * 20);
    }
  }
  if (entity?.claims?.P1128 || entity?.claims?.P2139) score += 5;
  return score;
}

/**
 * @param {{ name?: string, website?: string }} org
 */
async function firmographicsFromWikidata(org) {
  const host = websiteHost(org.website || '');
  const name = cleanStr(org.name, 200);
  /** @type {{ id: string, label?: string, description?: string }[]} */
  let searchHits = [];
  try {
    searchHits = await searchWikidataCandidates(name || host, host);
  } catch {
    return null;
  }
  if (!searchHits.length) return null;
  let entities;
  try {
    entities = await getWikidataEntities(searchHits.map((h) => h.id));
  } catch {
    return null;
  }

  /** @type {{ id: string, score: number, entity: object } | null} */
  let best = null;
  for (const hit of searchHits) {
    const entity = entities[hit.id];
    if (!entity || entity.missing) continue;
    const score = scoreWikidataEntity(org, entity, hit.label || '');
    if (score < 40) continue;
    if (!best || score > best.score) best = { id: hit.id, score, entity };
  }
  if (!best) return null;

  const employeesQ = bestQuantity(best.entity, 'P1128');
  const revenueQ = bestQuantity(best.entity, 'P2139');
  const employeeCount = employeesQ ? formatEmployeeCount(employeesQ.amount) : '';
  let annualRevenue = '';
  if (revenueQ && isUsdUnit(revenueQ.unit)) {
    annualRevenue = formatUsdRevenue(revenueQ.amount);
  } else if (revenueQ) {
    annualRevenue = formatEmployeeCount(revenueQ.amount);
  }

  if (!employeeCount && !annualRevenue) return null;
  return {
    employeeCount,
    annualRevenue,
    sources: [`https://www.wikidata.org/wiki/${best.id}`],
    provider: 'wikidata',
    matchScore: best.score,
  };
}

async function loadSecTickers() {
  if (!tickersCache) {
    tickersCache = (async () => {
      const data = await fetchJson(SEC_TICKERS_URL, {
        headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
      });
      /** @type {{ cik: string, ticker: string, title: string }[]} */
      const out = [];
      for (const row of Object.values(data || {})) {
        if (!row || typeof row !== 'object') continue;
        const cik = String(row.cik_str ?? '').trim();
        const ticker = cleanStr(row.ticker, 20).toUpperCase();
        const title = cleanStr(row.title, 300);
        if (!cik || !title) continue;
        out.push({ cik: cik.padStart(10, '0'), ticker, title });
      }
      return out;
    })().catch((e) => {
      tickersCache = null;
      throw e;
    });
  }
  return tickersCache;
}

/**
 * @param {string} name
 * @param {{ cik: string, ticker: string, title: string }[]} tickers
 */
function findSecCikByName(name, tickers) {
  const key = normalizeOrgName(name);
  if (!key || key.length < 2) return null;
  /** @type {{ row: { cik: string, ticker: string, title: string }, score: number } | null} */
  let best = null;
  for (const row of tickers) {
    const titleKey = normalizeOrgName(row.title);
    if (!titleKey) continue;
    let score = 0;
    if (titleKey === key) score = 100;
    else if (titleKey.startsWith(key) || key.startsWith(titleKey)) score = 85;
    else if (titleKey.includes(key) || key.includes(titleKey)) score = 70;
    else {
      const a = new Set(key.split(' ').filter((t) => t.length > 2));
      const b = new Set(titleKey.split(' ').filter((t) => t.length > 2));
      if (!a.size || !b.size) continue;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter += 1;
      const ratio = inter / Math.max(a.size, b.size);
      if (ratio < 0.8 || inter < 1) continue;
      score = Math.round(ratio * 65);
    }
    if (score < 70) continue;
    if (!best || score > best.score) best = { row, score };
  }
  return best;
}

/**
 * @param {object} facts
 */
function latestFyUsdFact(facts, keys) {
  const usgaap = facts?.facts?.['us-gaap'] || {};
  for (const key of keys) {
    const node = usgaap[key];
    const usd = node?.units?.USD;
    if (!Array.isArray(usd) || !usd.length) continue;
    const fy = usd
      .filter((x) => x && (x.form === '10-K' || x.form === '20-F') && (x.fp === 'FY' || !x.fp))
      .sort((a, b) => String(a.end || '').localeCompare(String(b.end || '')));
    const hit = fy.length ? fy[fy.length - 1] : null;
    if (hit && Number.isFinite(Number(hit.val))) {
      return { val: Number(hit.val), fy: hit.fy || null, key, end: hit.end || '' };
    }
  }
  return null;
}

/**
 * @param {object} facts
 */
function latestEmployeeFact(facts) {
  const buckets = [facts?.facts?.dei || {}, facts?.facts?.['us-gaap'] || {}];
  const keys = ['EntityNumberOfEmployees', 'NumberOfEmployees', 'Workforce'];
  for (const bag of buckets) {
    for (const key of keys) {
      const node = bag[key];
      if (!node?.units) continue;
      const series = node.units.pure || node.units.Number || Object.values(node.units)[0];
      if (!Array.isArray(series) || !series.length) continue;
      const fy = series
        .filter((x) => x && (x.form === '10-K' || x.form === '20-F' || !x.form))
        .sort((a, b) => String(a.end || '').localeCompare(String(b.end || '')));
      const hit = fy.length ? fy[fy.length - 1] : series[series.length - 1];
      const n = Number(hit?.val);
      if (Number.isFinite(n) && n > 0) return { val: n, fy: hit.fy || null, key };
    }
  }
  return null;
}

/**
 * @param {{ name?: string, website?: string }} org
 */
async function firmographicsFromSec(org) {
  const name = cleanStr(org.name, 200);
  if (!name) return null;
  let tickers;
  try {
    tickers = await loadSecTickers();
  } catch {
    return null;
  }
  const match = findSecCikByName(name, tickers);
  if (!match) return null;

  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${match.row.cik}.json`;
  let facts;
  try {
    facts = await fetchJson(url, {
      headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
    });
  } catch {
    return null;
  }

  const rev = latestFyUsdFact(facts, [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
  ]);
  const emp = latestEmployeeFact(facts);
  const employeeCount = emp ? formatEmployeeCount(emp.val) : '';
  const annualRevenue = rev ? formatUsdRevenue(rev.val, rev.fy) : '';
  if (!employeeCount && !annualRevenue) return null;

  return {
    employeeCount,
    annualRevenue,
    sources: [
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${match.row.cik}`,
      url,
    ],
    provider: 'sec-edgar',
    ticker: match.row.ticker,
    matchScore: match.score,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function apolloApiKey(env = process.env) {
  return String(env.APOLLO_API_KEY || '').trim();
}

/**
 * Format Apollo's annual_revenue_printed (e.g. "100M", "$1.2B") for the card.
 * @param {unknown} printed
 * @param {unknown} rawUsd
 */
function formatApolloRevenue(printed, rawUsd) {
  const p = cleanStr(printed, 40);
  if (p) {
    const withDollar = p.startsWith('$') ? p : `$${p.replace(/^\$/, '')}`;
    return `${withDollar} (est.)`;
  }
  const n = Number(rawUsd);
  if (Number.isFinite(n) && n > 0) return `${formatUsdRevenue(n)} (est.)`;
  return '';
}

/**
 * Apollo Organization Enrichment — estimated headcount + revenue for private / small cos.
 * @param {{ name?: string, website?: string, linkedin?: string }} org
 * @param {NodeJS.ProcessEnv} [env]
 */
async function firmographicsFromApollo(org, env = process.env) {
  const key = apolloApiKey(env);
  if (!key) return null;

  const host = websiteHost(org.website || '');
  const name = cleanStr(org.name, 200);
  const linkedin = cleanStr(org.linkedin, 400);
  if (!host && !name && !linkedin) return null;

  const params = new URLSearchParams();
  if (host) params.set('domain', host);
  if (name) params.set('name', name);
  if (org.website && /^https?:\/\//i.test(String(org.website))) {
    params.set('website', String(org.website).trim());
  } else if (host) {
    params.set('website', `https://${host}`);
  }
  if (linkedin && /linkedin\.com/i.test(linkedin)) params.set('linkedin_url', linkedin);

  let data;
  try {
    data = await fetchJson(`${APOLLO_ORG_ENRICH}?${params}`, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': key,
        'User-Agent': SEC_UA,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }

  const o = data?.organization;
  if (!o || typeof o !== 'object') return null;

  const empN = Number(o.estimated_num_employees);
  const employeeCount = Number.isFinite(empN) && empN > 0 ? formatEmployeeCount(empN) : '';
  const annualRevenue = formatApolloRevenue(o.annual_revenue_printed, o.annual_revenue);
  if (!employeeCount && !annualRevenue) return null;

  const domain = cleanStr(o.primary_domain || host, 120);
  return {
    employeeCount: employeeCount ? `${employeeCount} (est.)` : '',
    annualRevenue,
    sources: [
      domain ? `https://app.apollo.io/#/companies?qOrganizationName=${encodeURIComponent(name || domain)}` : 'https://www.apollo.io/',
    ],
    provider: 'apollo',
    matchScore: 60,
  };
}

/**
 * Look up employees + yearly revenue.
 * Priority: SEC revenue (filings) → Wikidata → Apollo estimates for gaps (small / private).
 * @param {{ name?: string, website?: string, linkedin?: string }} org
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{
 *   employeeCount: string,
 *   annualRevenue: string,
 *   sources: string[],
 *   providers: string[],
 * }>}
 */
export async function fetchOrgFirmographics(org, env = process.env) {
  const empty = { employeeCount: '', annualRevenue: '', sources: [], providers: [] };
  if (!org || (!cleanStr(org.name) && !websiteHost(org.website || ''))) return empty;

  const settled = await Promise.allSettled([
    firmographicsFromWikidata(org),
    firmographicsFromSec(org),
  ]);
  /** @type {NonNullable<Awaited<ReturnType<typeof firmographicsFromWikidata>>>[]} */
  const parts = settled
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => /** @type {NonNullable<Awaited<ReturnType<typeof firmographicsFromWikidata>>>} */ (r.value));

  const byProvider = Object.fromEntries(parts.map((p) => [p.provider, p]));
  const sec = byProvider['sec-edgar'];
  const wiki = byProvider.wikidata;

  let employeeCount = wiki?.employeeCount || sec?.employeeCount || '';
  let annualRevenue = sec?.annualRevenue || wiki?.annualRevenue || '';

  // Apollo only when a field is still empty (saves credits; fills small/private gaps).
  if ((!employeeCount || !annualRevenue) && apolloApiKey(env)) {
    try {
      const apollo = await firmographicsFromApollo(org, env);
      if (apollo) {
        parts.push(apollo);
        if (!employeeCount && apollo.employeeCount) employeeCount = apollo.employeeCount;
        if (!annualRevenue && apollo.annualRevenue) annualRevenue = apollo.annualRevenue;
      }
    } catch {
      /* ignore */
    }
  }

  if (!employeeCount && !annualRevenue) return empty;

  const sources = [...new Set(parts.flatMap((p) => p.sources || []))].slice(0, 8);
  const providers = [...new Set(parts.map((p) => p.provider))];

  return { employeeCount, annualRevenue, sources, providers };
}
