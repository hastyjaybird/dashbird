/**
 * Headless Chromium (Playwright) search for Network enrich.
 *
 * Google blocks datacenter/headless traffic with captchas, so we drive Chrome
 * against Brave Search (and Bing Images as a backup) — same browser engine,
 * results closer to what you see in Chrome than DuckDuckGo’s lite HTML scrape.
 */
import { chromium } from 'playwright';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** @type {import('playwright').Browser | null} */
let browser = null;
/** @type {Promise<import('playwright').Browser> | null} */
let launching = null;
/** Serialize page work so enrich does not spawn a flood of Chromium tabs. */
let chain = Promise.resolve();
let inFlight = 0;
const MAX_IN_FLIGHT = 2;

function chromeSearchEnabled(env = process.env) {
  const v = String(env.ENRICH_SEARCH_ENGINE || 'chrome')
    .trim()
    .toLowerCase();
  return v !== 'duckduckgo' && v !== 'ddg' && v !== '0' && v !== 'off';
}

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  launching = (async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    browser.on('disconnected', () => {
      browser = null;
    });
    return browser;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withPageSlot(fn) {
  const run = chain.then(async () => {
    while (inFlight >= MAX_IN_FLIGHT) {
      await new Promise((r) => setTimeout(r, 50));
    }
    inFlight += 1;
    try {
      return await fn();
    } finally {
      inFlight -= 1;
    }
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Brave CDN encodes the source image as base64 path segments after `/g:ce/`.
 * @param {string} proxyUrl
 */
function decodeBraveImageProxy(proxyUrl) {
  const s = String(proxyUrl || '').trim();
  if (!s) return '';
  const idx = s.indexOf('/g:ce/');
  if (idx < 0) return s;
  try {
    const b64 = s
      .slice(idx + 6)
      .replace(/\//g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    // keep proxy
  }
  return s;
}

/**
 * @param {string} url
 */
function isNoiseHost(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    return (
      host === 'brave.com' ||
      host.endsWith('.brave.com') ||
      host === 'search.brave.com' ||
      host === 'bing.com' ||
      host.endsWith('.bing.com') ||
      host === 'microsoft.com' ||
      host.endsWith('.microsoft.com') ||
      host === 'duckduckgo.com' ||
      host.endsWith('.duckduckgo.com') ||
      host === 'google.com' ||
      host.endsWith('.google.com') ||
      host === 'youtube.com' ||
      host.endsWith('.youtube.com')
    );
  } catch {
    return true;
  }
}

/**
 * Skip LinkedIn chrome / auth / games nav that Brave often pulls from snippets.
 * @param {string} url
 */
function isLowValueResultUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
      if (
        /^\/(login|signup|games|pulse\/topics|feed|uas\/|authwall|checkpoint)\b/i.test(path) ||
        u.searchParams.has('session_redirect') ||
        /\/login/i.test(path)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Web search via headless Chrome → Brave Search.
 * @param {string} query
 * @param {number} [limit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string[]>}
 */
export async function searchGoogleResultUrls(query, limit = 6, env = process.env) {
  return searchChromeResultUrls(query, limit, env);
}

/**
 * @param {string} query
 * @param {number} [limit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string[]>}
 */
export async function searchChromeResultUrls(query, limit = 6, env = process.env) {
  if (!chromeSearchEnabled(env)) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  const max = Math.max(1, Math.min(12, Number(limit) || 6));

  return withPageSlot(async () => {
    let context = null;
    try {
      const b = await getBrowser();
      context = await b.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: BROWSER_UA,
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(14_000);
      const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 14_000 });
      await page.waitForSelector('#results, main a[href^="http"]', { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(400);

      const raw = await page.evaluate((lim) => {
        /** @type {string[]} */
        const out = [];
        const push = (href) => {
          const s = String(href || '').trim();
          if (!s || !/^https?:\/\//i.test(s)) return;
          if (out.includes(s)) return;
          out.push(s);
        };
        // Prefer result title links over chrome/nav chrome inside snippets.
        const titleSelectors = [
          '#results .snippet a[href^="http"]',
          '#results a[data-testid="result-title-a"]',
          'div[data-type="web"] a[href^="http"]',
          '.fdb a[href^="http"]',
        ];
        for (const sel of titleSelectors) {
          for (const a of document.querySelectorAll(sel)) {
            const el = /** @type {HTMLAnchorElement} */ (a);
            // Skip tiny nav-looking links inside result cards.
            const text = String(el.textContent || '').trim();
            if (text && text.length < 3) continue;
            push(el.href);
            if (out.length >= lim) return out;
          }
        }
        if (out.length < 3) {
          for (const a of document.querySelectorAll('#results a[href^="http"]')) {
            push(/** @type {HTMLAnchorElement} */ (a).href);
            if (out.length >= lim) break;
          }
        }
        return out;
      }, max * 3);

      /** @type {string[]} */
      const urls = [];
      for (const href of raw) {
        if (!href || isNoiseHost(href)) continue;
        if (isLowValueResultUrl(href)) continue;
        if (urls.includes(href)) continue;
        urls.push(href);
        if (urls.length >= max) break;
      }
      return urls;
    } catch (e) {
      console.warn('[chrome-web-search] web search failed', String(e?.message || e).slice(0, 160));
      return [];
    } finally {
      await context?.close().catch(() => {});
    }
  });
}

/**
 * Image search via headless Chrome → Brave Images (Bing Images backup).
 * @param {string} query
 * @param {number} [limit]
 * @param {{ preferSquare?: boolean }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ url: string, thumbUrl: string | null, pageUrl: string | null }[]>}
 */
export async function searchGoogleImageResults(query, limit = 10, opts = {}, env = process.env) {
  return searchChromeImageResults(query, limit, opts, env);
}

/**
 * @param {string} query
 * @param {number} [limit]
 * @param {{ preferSquare?: boolean }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ url: string, thumbUrl: string | null, pageUrl: string | null }[]>}
 */
export async function searchChromeImageResults(query, limit = 10, opts = {}, env = process.env) {
  if (!chromeSearchEnabled(env)) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  const max = Math.max(1, Math.min(24, Number(limit) || 10));
  const preferSquare = Boolean(opts.preferSquare);

  const braveHits = await withPageSlot(async () => {
    let context = null;
    try {
      const b = await getBrowser();
      context = await b.newContext({
        viewport: { width: 1400, height: 1000 },
        userAgent: BROWSER_UA,
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(16_000);
      await page.goto(`https://search.brave.com/images?q=${encodeURIComponent(q)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 16_000,
      });
      await page.waitForSelector('.image-result img, .image-wrapper img', { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(500);

      return await page.evaluate((lim) => {
        /** @type {{ proxy: string, site: string }[]} */
        const out = [];
        for (const card of document.querySelectorAll('.image-result')) {
          const img = card.querySelector('.image-wrapper img, img:not(.favicon)');
          const proxy = String(img?.currentSrc || img?.src || '').trim();
          if (!proxy || !/^https?:\/\//i.test(proxy)) continue;
          if (/brave-logo|favicon/i.test(proxy)) continue;
          const site = String(card.querySelector('.image-metadata-site')?.textContent || '')
            .trim()
            .slice(0, 120);
          out.push({ proxy, site });
          if (out.length >= lim) break;
        }
        return out;
      }, max * 2);
    } catch (e) {
      console.warn('[chrome-web-search] brave images failed', String(e?.message || e).slice(0, 160));
      return [];
    } finally {
      await context?.close().catch(() => {});
    }
  });

  /** @type {{ url: string, thumbUrl: string | null, pageUrl: string | null, score: number }[]} */
  const scored = [];
  const pushScored = (url, thumbUrl, pageUrl, score = 0) => {
    const s = String(url || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (scored.some((x) => x.url === s)) return;
    scored.push({
      url: s,
      thumbUrl: thumbUrl && /^https?:\/\//i.test(thumbUrl) ? thumbUrl : null,
      pageUrl: pageUrl && /^https?:\/\//i.test(pageUrl) && !isNoiseHost(pageUrl) ? pageUrl : null,
      score,
    });
  };

  for (const row of braveHits) {
    const original = decodeBraveImageProxy(row.proxy);
    let score = 0;
    if (/linkedin|licdn/i.test(original) || /linkedin/i.test(row.site)) score += 8;
    if (preferSquare) score += 1;
    pushScored(original, row.proxy, null, score);
  }

  if (scored.length < max) {
    const bingHits = await withPageSlot(async () => {
      let context = null;
      try {
        const b = await getBrowser();
        context = await b.newContext({
          viewport: { width: 1400, height: 1000 },
          userAgent: BROWSER_UA,
          locale: 'en-US',
        });
        const page = await context.newPage();
        page.setDefaultTimeout(16_000);
        await page.goto(`https://www.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2`, {
          waitUntil: 'domcontentloaded',
          timeout: 16_000,
        });
        await page.waitForSelector('a.iusc, img.mimg', { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(400);
        return await page.evaluate((lim) => {
          /** @type {{ url: string, page: string | null, thumb: string | null }[]} */
          const out = [];
          for (const a of document.querySelectorAll('a.iusc')) {
            try {
              const m = JSON.parse(a.getAttribute('m') || '{}');
              const url = String(m.murl || '').trim();
              if (!url || !/^https?:\/\//i.test(url)) continue;
              out.push({
                url,
                page: m.purl ? String(m.purl) : null,
                thumb: m.turl ? String(m.turl) : null,
              });
            } catch {
              // ignore
            }
            if (out.length >= lim) break;
          }
          return out;
        }, max);
      } catch (e) {
        console.warn('[chrome-web-search] bing images failed', String(e?.message || e).slice(0, 160));
        return [];
      } finally {
        await context?.close().catch(() => {});
      }
    });

    for (const row of bingHits) {
      let score = 0;
      if (/linkedin|licdn/i.test(row.url) || /linkedin/i.test(row.page || '')) score += 8;
      pushScored(row.url, row.thumb, row.page, score);
    }
  }

  if (preferSquare) scored.sort((a, b) => b.score - a.score);
  else scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(({ url, thumbUrl, pageUrl }) => ({ url, thumbUrl, pageUrl }));
}

/**
 * @param {string} query
 * @param {number} [limit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string[]>}
 */
export async function searchGoogleImages(query, limit = 10, env = process.env) {
  const rows = await searchChromeImageResults(query, limit, {}, env);
  return rows.map((r) => r.url);
}
