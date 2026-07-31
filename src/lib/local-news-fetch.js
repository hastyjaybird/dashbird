/**
 * Local News feed fetch — RSS/Atom plus a few stable official list/API adapters
 * for Anthropic Beneficial Deployments monitoring (no LinkedIn login scrape).
 */
import { fetchFeedItems } from './local-news-rss.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/124.0.0.0 Safari/537.36 Dashbird/1.0 (+local-news-reader)';

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * @param {string} s
 */
function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} raw
 * @returns {string | null}
 */
function parseAnthropicDate(raw) {
  const m = String(raw || '').match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})\b/i,
  );
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (month == null) return null;
  const d = new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {string} working
 * @param {string} path
 */
function extractAnthropicTitle(working, path) {
  let t = String(working || '').trim();
  const lead =
    t.match(/^(Introducing\s+.+?)(?:\.\s|$)/i)
    || t.match(/^(Apply for\s+.+?)(?:\.\s|$)/i)
    || t.match(/^(Our position on\s+.+?)(?:\.\s|$)/i);
  if (lead) t = lead[1].trim();
  else {
    const parts = t.split(/(?<=\.)\s+/);
    t = (parts[0] || t).trim();
  }
  // "Introducing Claude Opus 5 Opus 5 is a step…" → "Introducing Claude Opus 5"
  t = t.replace(
    /^(Introducing\s+Claude\s+(Opus|Sonnet|Fable|Mythos)\s+\d+(?:\.\d+)?)\s+\2\b.*/i,
    '$1',
  );
  t = t.replace(/^(Introducing\s+Claude\s+for\s+[A-Za-z][A-Za-z ]{0,40}?)\s+[A-Z].*/i, '$1');
  t = t.replace(/^(Redeploying\s+Fable\s+\d+)\b.*/i, '$1');
  if (t.length > 110) t = `${t.slice(0, 107).replace(/\s+\S*$/, '')}…`;
  if (!t) t = path.split('/').pop()?.replace(/-/g, ' ') || 'Anthropic news';
  return t.trim();
}

/**
 * Parse anthropic.com/news list-page HTML into feed items.
 * @param {string} html
 * @param {string} [baseUrl]
 */
export function parseAnthropicNewsHtml(html, baseUrl = 'https://www.anthropic.com') {
  const text = String(html || '');
  /** @type {Array<{ title: string, link: string, publishedAt: string | null, summary: string, imageUrl: null }>} */
  const items = [];
  const seen = new Set();
  const re = /href="(\/news\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of text.matchAll(re)) {
    const path = m[1];
    if (seen.has(path) || path === '/news' || path.endsWith('/news/')) continue;
    seen.add(path);
    const inner = stripTags(m[2]);
    if (!inner || inner.length < 4) continue;

    const publishedAt = parseAnthropicDate(inner);
    const dateStr = publishedAt
      ? inner.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i)?.[0]
      : '';

    let working = inner;
    if (dateStr) working = working.replace(dateStr, ' ').replace(/\s+/g, ' ').trim();
    working = working
      .replace(/\b(Product|Announcements|Case Study|Economic Research|Policy|Research|Company)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let title = extractAnthropicTitle(working, path);

    const summary = working.slice(0, 400);
    const link = new URL(path, baseUrl).href;
    items.push({
      title,
      link,
      publishedAt,
      summary,
      imageUrl: null,
    });
  }
  return items;
}

/**
 * BD-relevant Greenhouse job title filter (hiring signal, not full board dump).
 * @param {string} title
 */
export function isBdRelevantJobTitle(title) {
  const t = String(title || '');
  if (/beneficial\s*deployments/i.test(t)) return true;
  if (/claude\s*corps|economic\s*mobility|smallholder/i.test(t)) return true;
  if (/nonprofit|education/i.test(t) && /sales|success|partner|architect|manager|gtm/i.test(t)) {
    return true;
  }
  if (/applied\s*ai\s*architect/i.test(t) && /nonprofit|education|beneficial|mobility|agriculture|government/i.test(t)) {
    return true;
  }
  if (/partner\s*manager,\s*global\s*health/i.test(t)) return true; // track + demote in importance
  if (/life\s*sciences/i.test(t) && /beneficial|deployments|applied\s*ai/i.test(t)) return true;
  return false;
}

/**
 * @param {object} payload Greenhouse board jobs JSON
 */
export function parseGreenhouseBdJobs(payload) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  /** @type {Array<{ title: string, link: string, publishedAt: string | null, summary: string, imageUrl: null }>} */
  const items = [];
  for (const job of jobs) {
    const title = String(job?.title || '').trim();
    if (!title || !isBdRelevantJobTitle(title)) continue;
    const link = String(job?.absolute_url || '').trim();
    if (!link) continue;
    const loc = String(job?.location?.name || '').trim();
    const updated = job?.updated_at || job?.first_published || null;
    let publishedAt = null;
    if (updated) {
      const d = new Date(updated);
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }
    items.push({
      title: `[Job] ${title}`,
      link,
      publishedAt,
      summary: loc ? `Anthropic careers · ${loc}` : 'Anthropic careers (Beneficial Deployments watch)',
      imageUrl: null,
    });
  }
  return items;
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 */
async function fetchText(url, timeoutMs = 12000) {
  const href = String(url || '').trim();
  if (!/^https?:\/\//i.test(href)) return { ok: false, text: '', error: 'invalid_url' };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(href, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html, application/json, application/rss+xml, application/xml, */*',
      },
    });
    if (!res.ok) return { ok: false, text: '', error: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (e) {
    return { ok: false, text: '', error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {object} feed directory / subscription entry
 * @returns {Promise<{ ok: boolean, items: Array<object>, error?: string }>}
 */
export async function fetchLocalNewsFeed(feed) {
  const mode = String(feed?.fetchMode || 'rss').trim() || 'rss';
  const url = String(feed?.url || '').trim();

  if (mode === 'anthropic-news-html') {
    const page = await fetchText(url || 'https://www.anthropic.com/news');
    if (!page.ok) return { ok: false, items: [], error: page.error };
    return { ok: true, items: parseAnthropicNewsHtml(page.text) };
  }

  if (mode === 'greenhouse-bd-jobs') {
    const page = await fetchText(
      url || 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs',
    );
    if (!page.ok) return { ok: false, items: [], error: page.error };
    try {
      const payload = JSON.parse(page.text);
      return { ok: true, items: parseGreenhouseBdJobs(payload) };
    } catch (e) {
      return { ok: false, items: [], error: String(e?.message || e) };
    }
  }

  return fetchFeedItems(url);
}
