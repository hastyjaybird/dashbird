/**
 * Minimal RSS 2.0 / Atom fetch + parse — no XML DOM dependency in this project,
 * so items are pulled out with regex over well-formed feed XML.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/124.0.0.0 Safari/537.36 Dashbird/1.0 (+local-news-reader)';

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * @param {string} s
 */
function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ENTITIES[name]);
}

/**
 * @param {string} s
 */
function stripTags(s) {
  return decodeXmlEntities(String(s || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} block
 * @param {string} tag
 */
function tagContent(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return m[1].trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
}

/**
 * First image URL from RSS enclosure, media tags, or inline img in description.
 * @param {string} block
 */
function extractImage(block) {
  const enclosure = block.match(
    /<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*(?:\btype=["']image[^"']*["']|)/i,
  );
  if (enclosure) {
    const typeM = (enclosure[0] || '').match(/\btype=["']([^"']+)["']/i);
    const type = typeM ? typeM[1].toLowerCase() : '';
    if (!type || type.startsWith('image/')) return enclosure[1].trim();
  }

  const mediaTags = [
    ...block.matchAll(/<media:(?:content|thumbnail)\b[^>]*\burl=["']([^"']+)["']/gi),
  ];
  for (const m of mediaTags) {
    const tag = m[0] || '';
    const mediumM = tag.match(/\bmedium=["']([^"']+)["']/i);
    const typeM = tag.match(/\btype=["']([^"']+)["']/i);
    const medium = mediumM ? mediumM[1].toLowerCase() : '';
    const type = typeM ? typeM[1].toLowerCase() : '';
    if (!medium || medium === 'image' || type.startsWith('image/')) return m[1].trim();
  }

  const desc =
    tagContent(block, 'description')
    || tagContent(block, 'summary')
    || tagContent(block, 'content');
  const img = desc.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  if (img) return img[1].trim();

  return '';
}

/**
 * Atom <link href="..."/> or RSS <link>text</link>.
 * @param {string} block
 */
function extractLink(block) {
  const atomLinks = [...block.matchAll(/<link\b([^>]*)\/?>(?:[\s\S]*?<\/link>)?/gi)];
  for (const m of atomLinks) {
    const attrs = m[1] || '';
    const relM = attrs.match(/rel=["']?([^"'\s>]+)/i);
    const rel = relM ? relM[1] : 'alternate';
    if (rel !== 'alternate' && rel !== '') continue;
    const hrefM = attrs.match(/href=["']([^"']+)["']/i);
    if (hrefM) return hrefM[1].trim();
  }
  const rss = tagContent(block, 'link');
  if (rss && !rss.includes('<')) return rss.trim();
  return '';
}

/**
 * @param {string} xml
 * @returns {Array<{ title: string, link: string, publishedAt: string | null, summary: string, imageUrl: string | null }>}
 */
export function parseFeedXml(xml) {
  const text = String(xml || '');
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const blocks = isAtom
    ? [...text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0])
    : [...text.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);

  const items = [];
  for (const block of blocks) {
    const title = stripTags(tagContent(block, 'title'));
    const link = extractLink(block);
    const dateRaw =
      tagContent(block, 'pubDate')
      || tagContent(block, 'published')
      || tagContent(block, 'updated')
      || tagContent(block, 'dc:date');
    let publishedAt = null;
    if (dateRaw) {
      const d = new Date(dateRaw.trim());
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }
    const summary = stripTags(
      tagContent(block, 'description') || tagContent(block, 'summary') || tagContent(block, 'content'),
    ).slice(0, 400);
    if (!title && !link) continue;
    const imageRaw = extractImage(block);
    const imageUrl = imageRaw && /^https?:\/\//i.test(imageRaw) ? imageRaw : null;
    items.push({ title: title || '(untitled)', link, publishedAt, summary, imageUrl });
  }
  return items;
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, items: Array<object>, error?: string }>}
 */
export async function fetchFeedItems(url, timeoutMs = 10000) {
  const href = String(url || '').trim();
  if (!/^https?:\/\//i.test(href)) return { ok: false, items: [], error: 'invalid_url' };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(href, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) return { ok: false, items: [], error: `HTTP ${res.status}` };
    const xml = await res.text();
    return { ok: true, items: parseFeedXml(xml) };
  } catch (e) {
    return { ok: false, items: [], error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}
