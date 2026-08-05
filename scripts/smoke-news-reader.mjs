/**
 * Screenshot smoke for the Local News Reader popout.
 *
 * Stubs /api/local-news with a fixture so the three list densities and the reading
 * pane can be checked without depending on whatever the live feeds happen to hold
 * (BD watch mode often leaves the real feed nearly empty).
 *
 * Usage: node scripts/smoke-news-reader.mjs [baseUrl]
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = 'tmp/news-reader';

const SUBS = [
  { id: 'verge', title: 'The Verge', category: 'tech' },
  { id: 'ars', title: 'Ars Technica', category: 'tech' },
  { id: 'bizj', title: 'Portland Business Journal', category: 'business' },
];

const IMG =
  'data:image/svg+xml;utf8,'
  + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">'
    + '<rect width="320" height="200" fill="#24405c"/>'
    + '<circle cx="160" cy="100" r="52" fill="#6ec8ff" opacity="0.5"/></svg>',
  );

function fixture() {
  const now = Date.now();
  const titles = [
    ['verge', 'Anthropic expands its enterprise partner program to the Pacific Northwest', true],
    ['ars', 'Researchers show a cheaper way to run long-context inference on commodity GPUs', false],
    ['bizj', 'Portland startup lands Series B to build regional logistics software', false],
    ['verge', 'A new open-source RSS aggregator wants to be the Inoreader alternative', false],
    ['ars', 'Linux 6.14 lands with better scheduler behavior for laptops', false],
    ['bizj', 'Downtown office vacancies dip for the first time in nine quarters', false],
    ['verge', 'The quiet return of the personal dashboard', false],
  ];
  const articles = titles.map(([feedId, title, important], i) => {
    const feed = SUBS.find((f) => f.id === feedId);
    return {
      id: `demo-${i}`,
      title,
      link: `https://example.com/demo-${i}`,
      publishedAt: new Date(now - (i + 1) * 47 * 60 * 1000).toISOString(),
      summary:
        'Feed summary text that gives a couple of sentences of context about the story '
        + 'so the card and magazine densities have something to clamp.',
      relevance:
        i % 2 === 0
          ? 'Relevant to your BD tracking — mentions partner motion in your target region.'
          : '',
      relevancePending: i === 3,
      imageUrl: i % 2 === 0 ? IMG : null,
      feedId,
      feedTitle: feed.title,
      category: feed.category,
      tags: [],
      tasteOk: true,
      tasteScore: 10 - i,
      important: Boolean(important),
      importance: important ? 9 : 4,
      importantReasons: important ? ['A:priority-role-or-bd-hiring'] : [],
      preferenceScore: 0,
      skipped: false,
    };
  });

  return {
    ok: true,
    enabled: true,
    relevanceEnabled: true,
    subscriptions: SUBS,
    pendingSuggestion: null,
    criteria: { lookFor: 'anthropic\nBD', skip: 'crypto', blacklist: 'sportsbook' },
    preferences: { commonalities: [], recentCount: 2, snoozedCount: 0 },
    skippedCount: 1,
    skippedArticles: [
      {
        ...articles[0],
        id: 'demo-skipped',
        title: 'A headline you skipped earlier',
        skipped: true,
        important: false,
        importance: 3,
      },
    ],
    articles,
    bdWatch: { startYmd: '2026-08-01', active: true, sameDayOnly: true, timeZone: 'America/Los_Angeles' },
  };
}

/** @param {import('playwright').Page} page */
async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  wrote ${OUT}/${name}.png`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await page.route('**/api/local-news', async (route) => {
    await route.fulfill({ json: fixture() });
  });
  // Stale cached payloads would paint before the stub lands.
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('dashbird-panel-v1:local-news');
      localStorage.removeItem('dashbird-news-read-v1');
      localStorage.removeItem('dashbird-news-reader-v1');
    } catch {
      /* ignore */
    }
  });

  console.log(`opening ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // Panels mount on idle; wait for the Reader entry point.
  await page.waitForSelector('#local-news-reader', { timeout: 20000 });
  await page.waitForSelector('.local-news__row', { timeout: 20000 });
  await shot(page, '01-sidebar');

  await page.click('#local-news-reader');
  await page.waitForSelector('.local-news__reader-item', { timeout: 10000 });
  await page.waitForTimeout(300);
  await shot(page, '02-reader-card');

  const panes = await page.evaluate(() => {
    const el = document.querySelector('.local-news__reader-panes');
    return el ? getComputedStyle(el).gridTemplateColumns : null;
  });
  console.log(`  panes grid: ${panes}`);

  // Select the first headline so the reading pane fills in.
  const firstItem = page.locator('.local-news__reader-item-open').first();
  if (await firstItem.count()) {
    await firstItem.click();
    await page.waitForTimeout(300);
    await shot(page, '03-reading-pane');
  } else {
    console.log('  (no articles in feed — reading pane left empty)');
  }

  for (const mode of ['Compact', 'Magazine']) {
    await page.click(`.local-news__reader-mode:text-is("${mode}")`);
    await page.waitForTimeout(250);
    await shot(page, `04-${mode.toLowerCase()}`);
  }

  // Keyword lists must still be reachable from the reader rail.
  await page.click('.local-news__reader-rail-btn[aria-label="Keyword lists"]');
  await page.waitForSelector('.local-news__lists-popout', { timeout: 8000 });
  const listsVisible = await page.locator('#local-news-lookfor').isVisible();
  console.log(`  lists popout fields visible: ${listsVisible}`);
  await shot(page, '05-lists');
  await page.keyboard.press('Escape');

  // Snooze is faceless typographic Zzz (SVG text), not a sleeping-face emoji.
  const snoozeIsSvg = await page.evaluate(() => {
    const b = document.querySelector('.local-news__reader-action--snooze')
      || document.querySelector('.local-news__card-action--snooze');
    if (!b) return 'no snooze button found';
    const svg = b.querySelector('svg');
    if (!svg) return `not svg / text="${b.textContent.trim()}"`;
    const label = [...svg.querySelectorAll('text')].map((t) => t.textContent).join('');
    const hasFace = /😴|💤/.test(b.textContent) || /😴|💤/.test(b.innerHTML);
    return `svg label="${label}" face=${hasFace}`;
  });
  console.log(`  snooze control: ${snoozeIsSvg}`);

  // Rail should expose Feeds / Lists / Feed editor.
  const railLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.local-news__reader-rail-btn')]
      .map((b) => b.getAttribute('aria-label'))
      .filter(Boolean),
  );
  console.log(`  rail: ${railLabels.join(', ')}`);

  await page.setViewportSize({ width: 800, height: 900 });
  await page.waitForTimeout(300);
  await shot(page, '06-narrow');

  await browser.close();

  if (errors.length) {
    console.log('\nJS errors:');
    for (const e of errors) console.log(`  ${e}`);
    process.exitCode = 1;
  } else {
    console.log('\nno JS errors');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
