/**
 * Software ratings — G2 scores discovered via Yahoo search snippets.
 * Falls back to OpenRouter JSON lookup when Yahoo has no match.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * @param {string} toolName
 * @returns {Promise<{ rating: number, source: string, reviewCount?: number, resolvedBy?: 'g2' | 'openrouter' } | null>}
 */
export async function fetchToolRating(toolName) {
  const name = String(toolName || '').trim();
  if (!name) return null;

  const g2 = await fetchG2RatingViaYahoo(name);
  if (g2) return { ...g2, resolvedBy: 'g2' };

  const ai = await fetchRatingViaOpenRouter(name).catch(() => null);
  if (ai) return { ...ai, resolvedBy: 'openrouter' };

  return null;
}

/** @deprecated use fetchToolRating */
export const fetchG2Rating = fetchToolRating;

/**
 * @param {string} toolName
 */
async function fetchG2RatingViaYahoo(toolName) {
  const queries = [
    `${toolName} G2 rating stars`,
    `${toolName} G2.com rating`,
    `site:g2.com ${toolName} rating`,
  ];
  for (const query of queries) {
    const hit = await searchYahooForG2(query);
    if (hit) return { ...hit, source: 'g2' };
  }
  return null;
}

/**
 * @param {string} query
 */
async function searchYahooForG2(query) {
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
    });
    if (!r.ok) return null;
    const html = await r.text();
    return parseG2FromHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} html
 */
function parseG2FromHtml(html) {
  const text = decodeHtmlEntities(stripTags(html)).replace(/\s+/g, ' ');
  const patterns = [
    /rated\s+([0-9]+(?:\.[0-9])?)\s+stars?\s+by\s+([\d,]+)\s+verified reviews?\s+on\s+G2/i,
    /has been rated\s+([0-9]+(?:\.[0-9])?)\s+stars?\s+by\s+([\d,]+)\s+verified reviews?\s+on\s+G2/i,
    /([0-9]+(?:\.[0-9])?)\s+stars?\s+by\s+([\d,]+)\s+verified reviews?\s+on\s+G2/i,
    /rated\s+([0-9]+(?:\.[0-9])?)\s+stars?\s+on\s+G2/i,
    /rated\s+([0-9]+(?:\.[0-9])?)\s+stars?/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const rating = clampRating(Number(m[1]));
    if (!Number.isFinite(rating)) continue;
    const reviewCount = m[2] ? Number(String(m[2]).replace(/,/g, '')) : undefined;
    return {
      rating,
      ...(Number.isFinite(reviewCount) ? { reviewCount } : {}),
    };
  }
  return null;
}

/**
 * @param {string} toolName
 */
async function fetchRatingViaOpenRouter(toolName) {
  const provider = String(process.env.TOOL_LIBRARY_AI_PROVIDER || 'openrouter').trim().toLowerCase();
  if (!provider || provider === 'none') return null;
  if (provider !== 'openrouter') return null;

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  const model = process.env.TOOL_LIBRARY_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
      'X-Title': 'dashbird-tool-library-ratings',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Return JSON only: { "rating": number (0-5, one decimal), "source": "g2" }. Use the widely cited G2 community rating for this software product. If unknown, return { "rating": null, "source": "" }.',
        },
        { role: 'user', content: `Software product: ${toolName}` },
      ],
    }),
  });

  if (!r.ok) return null;
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return null;
  const parsed = JSON.parse(content);
  const rating = clampRating(Number(parsed?.rating));
  if (!Number.isFinite(rating)) return null;
  return { rating, source: String(parsed?.source || 'g2') };
}

/**
 * @param {number} n
 */
function clampRating(n) {
  if (!Number.isFinite(n)) return NaN;
  return Math.min(5, Math.max(0, Math.round(n * 10) / 10));
}

/**
 * @param {string} s
 */
function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ');
}

/**
 * @param {string} s
 */
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
