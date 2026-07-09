/**
 * Headless Chromium page thumbnails for Tool Library (Playwright).
 * Used when og/icon/body image scrape cannot produce a usable snapshot.
 */
import { createHash } from 'node:crypto';
import { assertPublicHttpUrl, looksLikePublicHttpUrl } from './public-http-url.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** @type {import('playwright').Browser | null} */
let browser = null;
/** @type {Promise<import('playwright').Browser> | null} */
let launching = null;
let chain = Promise.resolve();

function screenshotsEnabled(env = process.env) {
  return String(env.TOOL_LIBRARY_SCREENSHOT || '1').trim() !== '0';
}

/**
 * Reject non-http(s) and obvious private/local targets (sync pre-check).
 * Prefer assertPublicHttpUrl before navigation.
 * @param {string} pageUrl
 */
export function isScreenshotableUrl(pageUrl) {
  return looksLikePublicHttpUrl(pageUrl);
}

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  launching = (async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: true,
      // Container runs as root; Chromium requires --no-sandbox. JS is disabled below.
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
 * Capture an above-the-fold PNG of a public homepage.
 * @param {string} pageUrl
 * @param {{ timeoutMs?: number, width?: number, height?: number }} [opts]
 * @returns {Promise<Buffer | null>}
 */
export async function capturePageThumbnail(pageUrl, opts = {}) {
  if (!screenshotsEnabled()) return null;
  let safeUrl;
  try {
    safeUrl = await assertPublicHttpUrl(pageUrl);
  } catch {
    return null;
  }

  const timeoutMs = Math.max(5_000, Number(opts.timeoutMs) || 25_000);
  const width = Math.min(1600, Math.max(640, Number(opts.width) || 1280));
  const height = Math.min(1200, Math.max(360, Number(opts.height) || 720));

  const run = async () => {
    let context = null;
    try {
      const b = await getBrowser();
      context = await b.newContext({
        viewport: { width, height },
        userAgent: BROWSER_UA,
        // Thumbnails do not need full JS; reduces renderer attack surface.
        javaScriptEnabled: false,
        ignoreHTTPSErrors: false,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      await page.route('**/*', async (route) => {
        const reqUrl = route.request().url();
        // Fast sync reject for subresources; main URL already passed DNS assert.
        if (!looksLikePublicHttpUrl(reqUrl)) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      const res = await page.goto(safeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      if (res && res.status() >= 400) return null;
      // Re-check final URL after redirects.
      try {
        await assertPublicHttpUrl(page.url());
      } catch {
        return null;
      }
      await page.waitForTimeout(300);
      const buf = await page.screenshot({
        type: 'png',
        fullPage: false,
        animations: 'disabled',
      });
      if (!buf || buf.length < 2_000) return null;
      return Buffer.from(buf);
    } catch (e) {
      console.warn('[tool-library] screenshot failed:', pageUrl, e?.message || e);
      return null;
    } finally {
      await context?.close().catch(() => {});
    }
  };

  // Serialize captures so one Chromium instance is not flooded by alternatives jobs.
  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Stable asset id for alternative candidates (shared across re-runs).
 * @param {string} pageUrl
 */
export function assetIdForUrl(pageUrl) {
  const hash = createHash('sha1').update(String(pageUrl || '')).digest('hex').slice(0, 12);
  return `alt-${hash}`;
}
