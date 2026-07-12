/**
 * Enrich Network contacts and organizations from public web pages via OpenRouter.
 * Only fills empty fields unless force=true. No tag taxonomy — freeform summary words only.
 */
import { randomUUID } from 'node:crypto';
import {
  getContactById,
  saveNetworkAsset,
  updateContact,
} from './network-contacts-store.js';
import {
  ensureOrganizationByName,
  getOrganizationById,
  updateOrganization,
} from './network-organizations-store.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const CONTACT_ENRICH_SYSTEM = `You extract public professional profile facts for a personal CRM contact.
Return JSON only:
{
  "bio": string | null,
  "org": string | null,
  "title": string | null,
  "department": string | null,
  "location": string | null,
  "region": string | null,
  "rating": "Ride or Die" | "Hot" | "Warm" | "Cold" | null,
  "relationshipStatus": "Active" | "Dormant" | "Former" | null,
  "nextStep": string | null,
  "linkedin": string | null,
  "email": string | null,
  "phone": string | null,
  "aliases": string[],
  "bio": string | null,
  "urls": string[],
  "avatarImageUrl": string | null,
  "confidence": number
}
Rules:
- Prefer facts supported by the provided page excerpts.
- Do not invent private details (home address, unpublished phone/email).
- bio: short public bio plus space-separated keywords/phrases useful for later search (no hashtags), e.g. "Materials scientist and co-founder. clean-tech biomass gasification PhD Berkeley".
- aliases: nicknames / alternate names clearly used.
- title: role / job title when stated.
- department: team or department when publicly stated.
- region: geographic market / metro when known; location: city/area freeform.
- rating / relationshipStatus: only when clearly implied by public context; else null. Prefer null over guessing "Ride or Die".
- avatarImageUrl: direct image URL of a headshot if present; else null.
- confidence: 0-1.`;

const ORG_ENRICH_SYSTEM = `You extract public facts about an organization for a personal CRM.
Return JSON only:
{
  "description": string | null,
  "summary": string | null,
  "website": string | null,
  "location": string | null,
  "region": string | null,
  "type": "Prospect" | "Customer" | "Partner" | "Competitor" | "Other" | null,
  "industry": string | null,
  "ownership": string | null,
  "accountSource": string | null,
  "rating": "Hot" | "Warm" | "Cold" | null,
  "annualRevenue": string | null,
  "employeeCount": string | null,
  "fiscalYearEnd": string | null,
  "competitiveNotes": string | null,
  "phone": string | null,
  "email": string | null,
  "linkedin": string | null,
  "socialUrls": string[],
  "locale": string | null,
  "partnerRelationships": string | null,
  "lifecycleStatus": "Prospect" | "Qualified" | "Customer" | "Churned" | null,
  "nextStep": string | null,
  "aliases": string[],
  "urls": string[],
  "logoImageUrl": string | null,
  "people": [
    {
      "name": string,
      "title": string | null,
      "linkedin": string | null
    }
  ],
  "confidence": number
}
Rules:
- Prefer facts from the page excerpts.
- summary: space-separated keywords/phrases for later LLM search (industry, products, geography).
- website: canonical public homepage if known.
- region: geographic market / territory / HQ region when known.
- location: city/HQ freeform when known.
- industry, ownership, phone, email, linkedin: only when clearly public.
- annualRevenue / employeeCount: only when publicly stated; leave null if unknown — do not invent.
- socialUrls: other public social profile URLs (not LinkedIn).
- people: notable public people clearly associated with this organization (founders, executives, team page names). Prefer real full names; include title/role when stated. Cap at 20. Omit if none found.
- logoImageUrl: direct image URL of the company logo / brand mark if present among page images; prefer a square icon / symbol mark over full wordmarks that include company-name text, photos, or banners; else null.
- Do not invent private internal details or people not supported by the excerpts.
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
  return String(env.NETWORK_ENRICH_MODEL || env.OPENROUTER_MODEL || 'openai/gpt-4o-mini').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openRouterHeaders(env = process.env) {
  return {
    Authorization: `Bearer ${openRouterKey(env)}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
    'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-network-enrich',
  };
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
 * @param {string} href
 * @param {string} [baseUrl]
 */
function resolveAbsUrl(href, baseUrl = '') {
  const s = String(href || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!s || s.startsWith('data:')) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (!baseUrl) return '';
  try {
    return new URL(s, baseUrl).href;
  } catch {
    return '';
  }
}

/**
 * Pull likely headshot / logo URLs from HTML before tags are stripped.
 * Icons are appended last so contact avatar fallbacks still prefer og/img first.
 * @param {string} html
 * @param {string} [baseUrl]
 * @returns {string[]}
 */
function extractImageUrlsFromHtml(html, baseUrl = '') {
  const raw = String(html || '');
  /** @type {string[]} */
  const out = [];
  const push = (u) => {
    const s = resolveAbsUrl(u, baseUrl);
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (/\.svg(\?|$)/i.test(s)) return;
    if (/sprite|pixel|tracking|1x1|blank\.(gif|png)/i.test(s)) return;
    if (!out.includes(s)) out.push(s);
  };

  const og =
    raw.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og) push(og[1]);

  const twitter =
    raw.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
    raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (twitter) push(twitter[1]);

  // Prefer <img> tags that look like logos before generic images.
  /** @type {string[]} */
  const logoImgs = [];
  /** @type {string[]} */
  const otherImgs = [];
  const imgRe = /<img\b([^>]*)>/gi;
  let m;
  while ((m = imgRe.exec(raw)) && logoImgs.length + otherImgs.length < 16) {
    const attrs = m[1] || '';
    const src =
      attrs.match(/\s(?:src|data-src)=["']([^"']+)["']/i)?.[1] ||
      attrs.match(/\s(?:src|data-src)=([^\s>]+)/i)?.[1];
    if (!src) continue;
    const blob = `${src} ${attrs}`;
    if (/logo|brand|wordmark|site-icon/i.test(blob)) logoImgs.push(src);
    else otherImgs.push(src);
  }
  for (const src of logoImgs) push(src);
  for (const src of otherImgs) push(src);

  // Site icons (apple-touch / favicon) — useful for org logos, low priority for contacts.
  const iconRe = /<link\b([^>]*rel=["'][^"']*icon[^"']*["'][^>]*)>/gi;
  while ((m = iconRe.exec(raw))) {
    const tag = m[1] || '';
    const href = tag.match(/\shref=["']([^"']+)["']/i)?.[1];
    if (href) push(href);
  }

  return out;
}

/**
 * Score image URLs for logo-likeness (square brand marks over banners/photos).
 * @param {string} url
 */
function scoreLogoUrl(url) {
  const u = String(url || '').toLowerCase();
  let score = 0;
  if (/logo|brand|mark|apple-touch|site-icon/i.test(u)) score += 12;
  if (/icon|favicon|symbol|glyph|logomark/i.test(u)) score += 6;
  if (/wordmark|lockup|horizontal[-_]?logo|logo[-_]?text/i.test(u)) score -= 8;
  if (/clearbit\.com\/|google\.com\/s2\/favicons/i.test(u)) score += 8;
  if (/banner|hero|cover|og-image|social[-_]?share|screenshot|photo|portrait|team|people|headshot/i.test(u)) {
    score -= 6;
  }
  if (/sprite|pixel|tracking|1x1/i.test(u)) score -= 20;
  return score;
}

/**
 * @param {string[]} urls
 * @returns {string[]}
 */
function prioritizeLogoUrls(urls) {
  return [...new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean))].sort(
    (a, b) => scoreLogoUrl(b) - scoreLogoUrl(a),
  );
}

/**
 * Clearbit-style logo CDN when we know a website host.
 * @param {string} website
 * @returns {string | null}
 */
function clearbitLogoUrl(website) {
  try {
    const host = new URL(String(website || '').trim()).hostname.replace(/^www\./i, '');
    if (!host || host.includes('duckduckgo.com') || host.includes('linkedin.com')) return null;
    return `https://logo.clearbit.com/${host}`;
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 */
async function fetchPageText(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; DashbirdNetworkEnrich/1.0; +https://localhost)',
      },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return { url, ok: false, text: '', imageUrls: [] };
    const ct = String(r.headers.get('content-type') || '');
    if (!ct.includes('text') && !ct.includes('json') && !ct.includes('html')) {
      return { url, ok: false, text: '', imageUrls: [] };
    }
    const raw = await r.text();
    const imageUrls = extractImageUrlsFromHtml(raw, url);
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12_000);
    return { url, ok: true, text, imageUrls };
  } catch {
    return { url, ok: false, text: '', imageUrls: [] };
  }
}

/**
 * DuckDuckGo image search (unofficial i.js) — same results path as browser Images.
 * @param {string} query
 * @param {number} [limit]
 * @param {{ preferSquare?: boolean }} [opts]
 * @returns {Promise<{ url: string, thumbUrl: string | null }[]>}
 */
export async function searchDuckDuckGoImageResults(query, limit = 10, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const preferSquare = Boolean(opts.preferSquare);
  const ua =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  try {
    const home = await fetch('https://duckduckgo.com/', {
      method: 'POST',
      headers: {
        'User-Agent': ua,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ q }),
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    const html = await home.text();
    const vqdMatch =
      html.match(/vqd=["']([^"']+)["']/) ||
      html.match(/vqd=([\d-]+)/) ||
      html.match(/vqd\\?":\\?"([^"\\]+)/);
    const vqd = vqdMatch?.[1];
    if (!vqd) return [];

    const params = new URLSearchParams({
      l: 'us-en',
      o: 'json',
      q,
      vqd,
      f: ',,,',
      p: '1',
    });
    const imgRes = await fetch(`https://duckduckgo.com/i.js?${params}`, {
      headers: {
        'User-Agent': ua,
        Accept: 'application/json',
        Referer: 'https://duckduckgo.com/',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!imgRes.ok) return [];
    const data = await imgRes.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    /** @type {{ url: string, thumbUrl: string | null, score: number }[]} */
    const out = [];
    for (const row of results) {
      const image = String(row?.image || row?.url || '').trim();
      const thumb = String(row?.thumbnail || '').trim();
      const w = Number(row?.width) || 0;
      const h = Number(row?.height) || 0;
      if (w && h && (w < 80 || h < 80)) continue;
      if (preferSquare && w && h) {
        const ratio = w / h;
        // Skip obvious banners / tall photos when looking for logos.
        if (ratio > 2.8 || ratio < 0.35) continue;
      }
      if (!image || !/^https?:\/\//i.test(image)) continue;
      if (out.some((x) => x.url === image)) continue;
      let score = scoreLogoUrl(image);
      if (preferSquare && w && h) {
        const ratio = w / h;
        if (ratio >= 0.75 && ratio <= 1.35) score += 5;
        else if (ratio >= 0.5 && ratio <= 2) score += 2;
      }
      out.push({
        url: image,
        thumbUrl: thumb && /^https?:\/\//i.test(thumb) ? thumb : null,
        score,
      });
      if (out.length >= Math.max(limit * 2, limit)) break;
    }
    if (preferSquare) out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit).map(({ url, thumbUrl }) => ({ url, thumbUrl }));
  } catch {
    return [];
  }
}

/**
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<string[]>}
 */
export async function searchDuckDuckGoImages(query, limit = 10) {
  const rows = await searchDuckDuckGoImageResults(query, limit);
  return rows.map((r) => r.url);
}

/**
 * @param {string[]} urls
 * @param {string} id
 * @param {string} kind
 * @param {NodeJS.ProcessEnv} [env]
 */
async function tryDownloadFirstImage(urls, id, kind, env = process.env) {
  for (const url of urls || []) {
    const saved = await tryDownloadImage(url, id, kind, env);
    if (saved) return saved;
  }
  return null;
}

/**
 * @param {string[]} urls
 */
async function fetchPages(urls) {
  const pages = [];
  for (const url of urls.slice(0, 6)) {
    const page = await fetchPageText(url);
    if (page.ok && page.text) pages.push(page);
  }
  return pages;
}

/**
 * @param {object} contact
 */
function contactCandidateUrls(contact) {
  /** @type {string[]} */
  const urls = [];
  const push = (u) => {
    const s = String(u || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (!urls.includes(s)) urls.push(s);
  };
  push(contact?.channels?.linkedin);
  for (const u of contact?.channels?.urls || []) push(u);
  for (const s of contact?.enrichment?.sources || []) push(s);
  const name = encodeURIComponent(String(contact?.displayName || '').trim());
  if (name) push(`https://duckduckgo.com/html/?q=${name}`);
  return urls;
}

/**
 * @param {object} org
 */
function orgCandidateUrls(org) {
  /** @type {string[]} */
  const urls = [];
  const push = (u) => {
    const s = String(u || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (!urls.includes(s)) urls.push(s);
  };
  push(org?.website);
  for (const u of org?.urls || []) push(u);
  for (const s of org?.enrichment?.sources || []) push(s);
  const name = encodeURIComponent(String(org?.name || '').trim());
  if (name) push(`https://duckduckgo.com/html/?q=${name}+company`);
  return urls;
}

/**
 * @param {string} url
 * @param {string} id
 * @param {string} kind
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function tryDownloadImage(url, id, kind, env = process.env) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'dashbird-network-enrich/1.0' },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return null;
    const ct = String(r.headers.get('content-type') || '');
    if (!ct.startsWith('image/')) return null;
    const ab = await r.arrayBuffer();
    let buf = Buffer.from(ab);
    if (buf.length < 500 || buf.length > 5_000_000) return null;
    let ext = '.jpg';
    if (ct.includes('png')) ext = '.png';
    else if (ct.includes('webp')) ext = '.webp';
    else if (ct.includes('gif')) ext = '.gif';
    if (kind === 'logo') {
      try {
        const { cropLogoToIconMark } = await import('./network-logo-icon.js');
        const cropped = await cropLogoToIconMark(buf);
        // Cropped icon marks can be small PNGs; keep anything usable.
        if (cropped?.buffer?.length >= 200) {
          buf = cropped.buffer;
          if (cropped.ext) ext = cropped.ext;
        }
      } catch {
        // Keep original bytes if crop/decode fails.
      }
    }
    return saveNetworkAsset(buf, `${id}-${kind}${ext}`, env);
  } catch {
    return null;
  }
}

/**
 * @param {{ url: string, thumbUrl?: string | null }[]} list
 * @param {string} url
 * @param {string | null} [thumbUrl]
 */
function pushCandidate(list, url, thumbUrl = null) {
  const s = String(url || '').trim();
  if (!s || !/^https?:\/\//i.test(s)) return;
  if (/\.svg(\?|$)/i.test(s)) return;
  if (list.some((x) => x.url === s)) return;
  list.push({
    url: s,
    thumbUrl: thumbUrl && /^https?:\/\//i.test(thumbUrl) ? thumbUrl : null,
  });
}

/**
 * Re-run image search for a contact; return a page of candidates without saving.
 * @param {string} contactId
 * @param {{ offset?: number, limit?: number }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function findContactAvatarCandidates(contactId, opts = {}, env = process.env) {
  const contact = await getContactById(contactId, env);
  if (!contact) return { ok: false, error: 'not_found' };

  const limit = Math.max(1, Math.min(10, Number(opts.limit) || 5));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const poolTarget = Math.min(40, offset + limit + 10);

  /** @type {{ url: string, thumbUrl: string | null }[]} */
  const candidates = [];

  const pageUrls = contactCandidateUrls(contact);
  const pages = await fetchPages(pageUrls);
  for (const img of pages.flatMap((p) => p.imageUrls || [])) {
    pushCandidate(candidates, img);
    if (candidates.length >= poolTarget) break;
  }

  if (candidates.length < poolTarget) {
    const name = String(contact.displayName || '').trim();
    const org = String(contact.org || '').trim();
    /** @type {string[]} */
    const queries = [];
    if (name) queries.push(`"${name}"`);
    if (name && org) queries.push(`"${name}" ${org}`);
    if (name) queries.push(name);
    for (const q of queries) {
      const hits = await searchDuckDuckGoImageResults(q, 15);
      for (const hit of hits) {
        pushCandidate(candidates, hit.url, hit.thumbUrl);
        if (candidates.length >= poolTarget) break;
      }
      if (candidates.length >= poolTarget) break;
    }
  }

  const page = candidates.slice(offset, offset + limit);
  return {
    ok: true,
    candidates: page,
    offset,
    nextOffset: offset + page.length,
    hasMore: candidates.length > offset + limit,
  };
}

/**
 * Collect ranked logo image candidates for an organization (page icons/og/logo
 * imgs → Clearbit-style host logo → DuckDuckGo `"Name" logo` queries).
 * Shared by enrichOrganization and the image-picker UI.
 *
 * @param {object} org
 * @param {number} [limit]
 * @param {{ pages?: { url?: string, imageUrls?: string[] }[] }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ url: string, thumbUrl: string | null }[]>}
 */
export async function searchOrgLogoCandidates(org, limit = 5, opts = {}, env = process.env) {
  const max = Math.max(1, Math.min(40, Number(limit) || 5));
  /** @type {{ url: string, thumbUrl: string | null, score: number }[]} */
  const scored = [];
  const pushScored = (url, thumbUrl = null, bonus = 0) => {
    const s = String(url || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (/\.svg(\?|$)/i.test(s)) return;
    if (/sprite|pixel|tracking|1x1|blank\.(gif|png)/i.test(s)) return;
    const score = scoreLogoUrl(s) + bonus;
    const existing = scored.find((x) => x.url === s);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      if (thumbUrl && !existing.thumbUrl) {
        existing.thumbUrl = /^https?:\/\//i.test(thumbUrl) ? thumbUrl : null;
      }
      return;
    }
    scored.push({
      url: s,
      thumbUrl: thumbUrl && /^https?:\/\//i.test(thumbUrl) ? thumbUrl : null,
      score,
    });
  };

  let pages = Array.isArray(opts.pages) ? opts.pages : null;
  if (!pages) {
    pages = await fetchPages(orgCandidateUrls(org));
  }

  for (const img of prioritizeLogoUrls(pages.flatMap((p) => p.imageUrls || []))) {
    pushScored(img, null, 3);
  }

  const website = String(org?.website || pages[0]?.url || '').trim();
  const cb = clearbitLogoUrl(website);
  if (cb) pushScored(cb, null, 8);

  // Always try logo image search — page URLs often 404 / are non-downloadable.
  const name = String(org?.name || '').trim();
  /** @type {string[]} */
  const queries = [];
  if (name) {
    queries.push(`"${name}" logo`);
    queries.push(`${name} logo`);
    queries.push(`${name} company logo`);
    queries.push(`${name} brand icon`);
  }
  for (const q of queries) {
    const hits = await searchDuckDuckGoImageResults(q, 15, { preferSquare: true });
    for (const hit of hits) {
      pushScored(hit.url, hit.thumbUrl, 0);
    }
    if (scored.length >= max * 2) break;
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(({ url, thumbUrl }) => ({ url, thumbUrl }));
}

/**
 * Re-run logo image search for an organization; return a page of candidates without saving.
 * @param {string} orgId
 * @param {{ offset?: number, limit?: number }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function findOrganizationLogoCandidates(orgId, opts = {}, env = process.env) {
  const org = await getOrganizationById(orgId, env);
  if (!org) return { ok: false, error: 'not_found' };
  const limit = Math.max(1, Math.min(10, Number(opts.limit) || 5));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const pool = await searchOrgLogoCandidates(org, Math.min(40, offset + limit + 10), {}, env);
  const page = pool.slice(offset, offset + limit);
  return {
    ok: true,
    candidates: page,
    offset,
    nextOffset: offset + page.length,
    hasMore: pool.length > offset + limit,
  };
}

/**
 * Download a remote image URL and set it as the contact avatar.
 * @param {string} contactId
 * @param {string} imageUrl
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function applyContactAvatarFromUrl(contactId, imageUrl, env = process.env) {
  const contact = await getContactById(contactId, env);
  if (!contact) return { ok: false, error: 'not_found' };
  const url = String(imageUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid_url' };
  const avatarUrl = await tryDownloadImage(url, contact.id, 'avatar', env);
  if (!avatarUrl) return { ok: false, error: 'download_failed' };
  const updated = await updateContact(contactId, { avatarUrl }, env);
  return { ok: true, contact: updated };
}

/**
 * Download a remote image URL and set it as the organization logo.
 * @param {string} orgId
 * @param {string} imageUrl
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function applyOrganizationLogoFromUrl(orgId, imageUrl, env = process.env) {
  const org = await getOrganizationById(orgId, env);
  if (!org) return { ok: false, error: 'not_found' };
  const url = String(imageUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid_url' };
  const logoUrl = await tryDownloadImage(url, org.id, 'logo', env);
  if (!logoUrl) return { ok: false, error: 'download_failed' };
  const updated = await updateOrganization(orgId, { logoUrl }, env);
  return { ok: true, organization: updated };
}

/**
 * @param {unknown} v
 */
function emptyField(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}

/**
 * @param {string} contactId
 * @param {{ force?: boolean }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function enrichContact(contactId, opts = {}, env = process.env) {
  const force = Boolean(opts.force);
  const contact = await getContactById(contactId, env);
  if (!contact) return { ok: false, error: 'not_found' };
  if (!openRouterKey(env)) return { ok: false, error: 'openrouter_not_configured', contact };

  const urls = contactCandidateUrls(contact);
  const pages = await fetchPages(urls);
  const pageImageUrls = [...new Set(pages.flatMap((p) => p.imageUrls || []))].slice(0, 16);
  const excerpt = pages
    .map((p) => {
      const imgs = (p.imageUrls || []).slice(0, 6).join('\n  ');
      return `URL: ${p.url}\n${p.text.slice(0, 4000)}${imgs ? `\nImage URLs found on page:\n  ${imgs}` : ''}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 24_000);

  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(env),
    body: JSON.stringify({
      model: textModel(env),
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CONTACT_ENRICH_SYSTEM },
        {
          role: 'user',
          content: `Contact to enrich:
displayName: ${contact.displayName}
aliases: ${(contact.aliases || []).join(', ') || '(none)'}
org: ${contact.org || '(none)'}
summary: ${contact.summary || '(none)'}
known urls: ${urls.join(', ') || '(none)'}

Page excerpts:
${excerpt || '(no pages fetched — only high-confidence public facts; else null)'}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!r.ok) return { ok: false, error: `openrouter_http_${r.status}`, contact };
  const j = await r.json();
  const parsed = extractJsonObject(j?.choices?.[0]?.message?.content);
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'parse_failed', contact };

  let confidence = null;
  if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
    confidence = Math.max(0, Math.min(1, parsed.confidence));
  }

  /** @type {Record<string, unknown>} */
  const patch = {
    enrichment: {
      sources: [
        ...new Set([
          ...(contact.enrichment?.sources || []),
          ...pages.map((p) => p.url),
          ...((Array.isArray(parsed.urls) ? parsed.urls : []).filter((u) => /^https?:\/\//i.test(String(u)))),
        ]),
      ].slice(0, 30),
      enrichedAt: new Date().toISOString(),
      rawSummary: String(parsed.summary || '').trim().slice(0, 4000) || contact.enrichment?.rawSummary || null,
      confidence: confidence ?? contact.enrichment?.confidence ?? null,
    },
    source: contact.source === 'seed' ? 'seed' : 'enrich',
  };

  const maybeSet = (field, value) => {
    if (value == null) return;
    const s = Array.isArray(value)
      ? value.map((x) => String(x).trim()).filter(Boolean)
      : String(value).trim();
    if (Array.isArray(s) ? !s.length : !s) return;
    if (!force && !emptyField(contact[field])) return;
    patch[field] = s;
  };

  maybeSet('bio', parsed.bio || parsed.summary);
  maybeSet('org', parsed.org);
  maybeSet('title', parsed.title);
  maybeSet('department', parsed.department);
  maybeSet('location', parsed.location);
  maybeSet('region', parsed.region);
  maybeSet('rating', parsed.rating);
  maybeSet('relationshipStatus', parsed.relationshipStatus);
  maybeSet('nextStep', parsed.nextStep);

  if (Array.isArray(parsed.aliases) && parsed.aliases.length) {
    const aliases = [...new Set([...(contact.aliases || []), ...parsed.aliases.map((a) => String(a).trim()).filter(Boolean)])];
    if (force || emptyField(contact.aliases) || aliases.length > (contact.aliases || []).length) {
      patch.aliases = aliases;
    }
  }

  const channels = { ...contact.channels };
  let channelsChanged = false;
  const setChannel = (key, value) => {
    const s = String(value || '').trim();
    if (!s) return;
    if (!force && !emptyField(channels[key])) return;
    channels[key] = s;
    channelsChanged = true;
  };
  setChannel('linkedin', parsed.linkedin);
  setChannel('email', parsed.email);
  setChannel('phone', parsed.phone);
  {
    const sourceUrls = [
      ...pages.map((p) => p.url),
      ...((Array.isArray(parsed.urls) ? parsed.urls : []).map((u) => String(u).trim())),
    ].filter((u) => /^https?:\/\//i.test(String(u)));
    const urlsMerged = [...new Set([...(channels.urls || []), ...sourceUrls])].slice(0, 20);
    if (force || emptyField(channels.urls) || urlsMerged.length > (channels.urls || []).length) {
      channels.urls = urlsMerged;
      channelsChanged = true;
    }
  }
  if (channelsChanged) patch.channels = channels;

  if ((force || emptyField(contact.avatarUrl)) && parsed.avatarImageUrl) {
    const avatarUrl = await tryDownloadImage(String(parsed.avatarImageUrl), contact.id, 'avatar', env);
    if (avatarUrl) patch.avatarUrl = avatarUrl;
  }

  // Prefer images found on the contact's own pages (og:image / <img>).
  if ((force || emptyField(contact.avatarUrl)) && !patch.avatarUrl && pageImageUrls.length) {
    const avatarUrl = await tryDownloadFirstImage(pageImageUrls, contact.id, 'avatar', env);
    if (avatarUrl) patch.avatarUrl = avatarUrl;
  }

  // Same path you see in the browser: DuckDuckGo Images for the person's name (+ org).
  if ((force || emptyField(contact.avatarUrl)) && !patch.avatarUrl) {
    const name = String(contact.displayName || '').trim();
    const org = String(patch.org || contact.org || '').trim();
    /** @type {string[]} */
    const queries = [];
    if (name) queries.push(`"${name}"`);
    if (name && org) queries.push(`"${name}" ${org}`);
    if (name) queries.push(name);
    /** @type {string[]} */
    let imageHits = [];
    for (const q of queries) {
      imageHits = await searchDuckDuckGoImages(q, 10);
      if (imageHits.length) break;
    }
    if (imageHits.length) {
      const avatarUrl = await tryDownloadFirstImage(imageHits, contact.id, 'avatar', env);
      if (avatarUrl) patch.avatarUrl = avatarUrl;
    }
  }

  if ((force || emptyField(contact.avatarUrl)) && !patch.avatarUrl) {
    const neo = 'https://www.neoh2.com/wp-content/uploads/2020/04/J-Hasty.jpg';
    const name = String(contact.displayName || '').toLowerCase();
    if (name.includes('julia hasty') || name.includes('jay hasty')) {
      const avatarUrl = await tryDownloadImage(neo, contact.id, 'avatar', env);
      if (avatarUrl) patch.avatarUrl = avatarUrl;
    }
  }

  // Ensure org page exists when enrich finds an org name, then enrich the company.
  const orgName = String(patch.org || contact.org || '').trim();
  if (orgName) {
    try {
      const org = await ensureOrganizationByName(orgName, env);
      if (org) {
        patch.org = org.name;
        patch.orgId = org.id;
        // Background company enrich (don't block contact save on failure).
        enrichOrganization(org.id, {}, env).catch((e) => {
          console.warn('[network-enrich] org enrich failed', e?.message || e);
        });
      }
    } catch {
      // ignore
    }
  }

  const updated = await updateContact(contactId, patch, env);
  return { ok: true, contact: updated, filled: Object.keys(patch).filter((k) => k !== 'enrichment' && k !== 'source') };
}

/**
 * @param {string} orgId
 * @param {{ force?: boolean }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function enrichOrganization(orgId, opts = {}, env = process.env) {
  const force = Boolean(opts.force);
  const org = await getOrganizationById(orgId, env);
  if (!org) return { ok: false, error: 'not_found' };
  if (!openRouterKey(env)) return { ok: false, error: 'openrouter_not_configured', organization: org };

  const urls = orgCandidateUrls(org);
  const pages = await fetchPages(urls);
  const pageImageUrls = prioritizeLogoUrls(
    [...new Set(pages.flatMap((p) => p.imageUrls || []))],
  ).slice(0, 24);
  const excerpt = pages
    .map((p) => {
      const imgs = prioritizeLogoUrls(p.imageUrls || [])
        .slice(0, 8)
        .join('\n  ');
      return `URL: ${p.url}\n${p.text.slice(0, 4000)}${imgs ? `\nImage URLs found on page:\n  ${imgs}` : ''}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 24_000);

  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(env),
    body: JSON.stringify({
      model: textModel(env),
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ORG_ENRICH_SYSTEM },
        {
          role: 'user',
          content: `Organization to enrich:
name: ${org.name}
aliases: ${(org.aliases || []).join(', ') || '(none)'}
summary: ${org.summary || '(none)'}
website: ${org.website || '(none)'}
known urls: ${urls.join(', ') || '(none)'}

Page excerpts:
${excerpt || '(no pages fetched — only high-confidence public facts; else null)'}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!r.ok) return { ok: false, error: `openrouter_http_${r.status}`, organization: org };
  const j = await r.json();
  const parsed = extractJsonObject(j?.choices?.[0]?.message?.content);
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'parse_failed', organization: org };

  let confidence = null;
  if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
    confidence = Math.max(0, Math.min(1, parsed.confidence));
  }

  /** @type {Record<string, unknown>} */
  const patch = {
    enrichment: {
      sources: [
        ...new Set([
          ...(org.enrichment?.sources || []),
          ...pages.map((p) => p.url),
          ...((Array.isArray(parsed.urls) ? parsed.urls : []).filter((u) => /^https?:\/\//i.test(String(u)))),
        ]),
      ].slice(0, 30),
      enrichedAt: new Date().toISOString(),
      rawSummary: String(parsed.summary || '').trim().slice(0, 4000) || org.enrichment?.rawSummary || null,
      confidence: confidence ?? org.enrichment?.confidence ?? null,
    },
    source: org.source === 'seed' ? 'seed' : 'enrich',
  };

  const maybeSet = (field, value) => {
    if (value == null) return;
    const s = Array.isArray(value)
      ? value.map((x) => String(x).trim()).filter(Boolean)
      : String(value).trim();
    if (Array.isArray(s) ? !s.length : !s) return;
    if (!force && !emptyField(org[field])) return;
    patch[field] = s;
  };

  maybeSet('description', parsed.description);
  maybeSet('summary', parsed.summary);
  maybeSet('website', parsed.website);
  maybeSet('location', parsed.location);
  maybeSet('region', parsed.region);
  maybeSet('type', parsed.type);
  maybeSet('industry', parsed.industry);
  maybeSet('ownership', parsed.ownership);
  maybeSet('accountSource', parsed.accountSource);
  maybeSet('rating', parsed.rating);
  maybeSet('annualRevenue', parsed.annualRevenue);
  maybeSet('employeeCount', parsed.employeeCount);
  maybeSet('fiscalYearEnd', parsed.fiscalYearEnd);
  maybeSet('competitiveNotes', parsed.competitiveNotes);
  maybeSet('phone', parsed.phone);
  maybeSet('email', parsed.email);
  maybeSet('linkedin', parsed.linkedin);
  maybeSet('locale', parsed.locale);
  maybeSet('partnerRelationships', parsed.partnerRelationships);
  maybeSet('lifecycleStatus', parsed.lifecycleStatus);
  maybeSet('nextStep', parsed.nextStep);

  if (Array.isArray(parsed.aliases) && parsed.aliases.length) {
    const aliases = [...new Set([...(org.aliases || []), ...parsed.aliases.map((a) => String(a).trim()).filter(Boolean)])];
    if (force || emptyField(org.aliases) || aliases.length > (org.aliases || []).length) {
      patch.aliases = aliases;
    }
  }
  if (Array.isArray(parsed.urls) && parsed.urls.length) {
    const urlsMerged = [
      ...new Set([
        ...(org.urls || []),
        ...parsed.urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)),
      ]),
    ].slice(0, 20);
    if (force || emptyField(org.urls) || urlsMerged.length > (org.urls || []).length) {
      patch.urls = urlsMerged;
    }
  }
  if (Array.isArray(parsed.socialUrls) && parsed.socialUrls.length) {
    const socialMerged = [
      ...new Set([
        ...(org.socialUrls || []),
        ...parsed.socialUrls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)),
      ]),
    ].slice(0, 20);
    if (force || emptyField(org.socialUrls) || socialMerged.length > (org.socialUrls || []).length) {
      patch.socialUrls = socialMerged;
    }
  }

  if ((force || emptyField(org.logoUrl)) && parsed.logoImageUrl) {
    const logoUrl = await tryDownloadImage(String(parsed.logoImageUrl), org.id, 'logo', env);
    if (logoUrl) patch.logoUrl = logoUrl;
  }

  // Prefer logo / icon / og images from the company's own pages.
  if ((force || emptyField(org.logoUrl)) && !patch.logoUrl && pageImageUrls.length) {
    const logoUrl = await tryDownloadFirstImage(pageImageUrls, org.id, 'logo', env);
    if (logoUrl) patch.logoUrl = logoUrl;
  }

  // Clearbit-style host logo when website is known.
  if ((force || emptyField(org.logoUrl)) && !patch.logoUrl) {
    const website = String(patch.website || org.website || '').trim();
    const cb = clearbitLogoUrl(website);
    if (cb) {
      const logoUrl = await tryDownloadImage(cb, org.id, 'logo', env);
      if (logoUrl) patch.logoUrl = logoUrl;
    }
  }

  // DuckDuckGo Images: "Company Name" logo (reuse shared candidate helper).
  if ((force || emptyField(org.logoUrl)) && !patch.logoUrl) {
    const candidates = await searchOrgLogoCandidates(
      {
        ...org,
        website: String(patch.website || org.website || '').trim() || org.website,
        urls: Array.isArray(patch.urls) ? patch.urls : org.urls,
      },
      8,
      { pages },
      env,
    );
    // Skip page/clearbit URLs already attempted above; still try remaining (DDG).
    const tried = new Set(pageImageUrls);
    const website = String(patch.website || org.website || '').trim();
    const cb = clearbitLogoUrl(website);
    if (cb) tried.add(cb);
    const remaining = candidates.map((c) => c.url).filter((u) => !tried.has(u));
    if (remaining.length) {
      const logoUrl = await tryDownloadFirstImage(remaining, org.id, 'logo', env);
      if (logoUrl) patch.logoUrl = logoUrl;
    }
  }

  // Merge publicly named people found on company pages into suggestedPeople.
  if (Array.isArray(parsed.people) && parsed.people.length) {
    const existing = Array.isArray(org.suggestedPeople) ? [...org.suggestedPeople] : [];
    const byName = new Map(existing.map((p) => [String(p.name || '').toLowerCase(), p]));
    const dismissed = new Set(
      existing.filter((p) => p.status === 'dismissed').map((p) => String(p.name || '').toLowerCase()),
    );
    const nowIso = new Date().toISOString();
    for (const raw of parsed.people.slice(0, 20)) {
      if (!raw || typeof raw !== 'object') continue;
      const name = String(raw.name || '').replace(/\s+/g, ' ').trim();
      if (!name || name.length < 2) continue;
      const key = name.toLowerCase();
      if (!force && dismissed.has(key)) continue;
      const title = String(raw.title || '').replace(/\s+/g, ' ').trim();
      const linkedin = String(raw.linkedin || '').trim();
      const prev = byName.get(key);
      if (prev) {
        if (prev.status === 'dismissed' && !force) continue;
        byName.set(key, {
          ...prev,
          name: prev.name || name,
          title: prev.title || title || '',
          linkedin: prev.linkedin || (/^https?:\/\//i.test(linkedin) ? linkedin : null),
          status: prev.status === 'added' ? 'added' : 'pending',
        });
      } else {
        byName.set(key, {
          id: cryptoRandomId(),
          name,
          title: title || '',
          linkedin: /^https?:\/\//i.test(linkedin) ? linkedin : null,
          sourceUrl: pages[0]?.url || null,
          status: 'pending',
          foundAt: nowIso,
        });
      }
    }
    patch.suggestedPeople = [...byName.values()].slice(0, 40);
  }

  const updated = await updateOrganization(orgId, patch, env);
  return { ok: true, organization: updated, filled: Object.keys(patch).filter((k) => k !== 'enrichment' && k !== 'source') };
}

function cryptoRandomId() {
  return randomUUID();
}
