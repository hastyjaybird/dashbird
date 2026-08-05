#!/usr/bin/env node
/**
 * Mobile shell panel-loading smoke checks.
 * Run: npm run smoke:mobile-panels        (DASHBIRD_BASE, BROWSER=chromium|firefox)
 *
 * Covers the failure Jay hit on the phone: a lazily imported panel module that
 * fails once stays broken until a full reload, and the browser only says
 * "error loading dynamically imported module".
 */

import { chromium, firefox, devices } from 'playwright';

const base = String(process.env.DASHBIRD_BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const which = String(process.env.BROWSER || 'chromium').toLowerCase();
const engine = which === 'firefox' ? firefox : chromium;
const contextOptions =
  which === 'firefox'
    ? {
        viewport: { width: 412, height: 915 },
        userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0',
      }
    : { ...devices['Pixel 5'] };

const failures = [];

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const browser = await engine.launch();
const context = await browser.newContext(contextOptions);
// Start every scenario on Notes so the Events panel mounts from scratch.
await context.addInitScript(() => {
  try {
    localStorage.setItem('dashbirdMobileTab', 'notes');
  } catch {
    /* ignore */
  }
});
const page = await context.newPage();

/** @param {string} name */
async function openTab(name) {
  await page
    .getByRole('button', { name: new RegExp(`^${name}$`) })
    .first()
    .click();
  await page.waitForTimeout(4000);
}

async function openMobile() {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.mobile-shell__tab', { timeout: 20000 });
  await page.waitForTimeout(1500);
}

/** @returns {Promise<string>} */
async function errorText() {
  const el = page.locator('.mobile-shell__status--error').first();
  if (!(await el.count())) return '';
  return String((await el.textContent()) || '').trim();
}

try {
  await openMobile();
  for (const [tab, selector] of [
    ['Events', '.mobile-events__toolbar'],
    ['Contacts', '#mount-mobile-network *'],
    ['Groups', '#mount-mobile-groups *'],
    ['Mail', '#mount-mobile-gmail *'],
    ['Tasks', '#mount-mobile-tasks *'],
    ['Notes', '#mount-mobile-notes *'],
  ]) {
    await openTab(tab);
    const errors = await page.locator('.mobile-shell__status--error').count();
    const nodes = await page.locator(selector).count();
    check(`${tab} panel mounts`, errors === 0 && nodes > 0, `errors=${errors} nodes=${nodes}`);
  }

  await openMobile();
  await page.route('**/events-finder-mobile.js*', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }),
  );
  await openTab('Events');
  let message = await errorText();
  check(
    'missing panel file names the 404',
    /events-finder-mobile\.js is missing on the server \(HTTP 404\)/.test(message),
    message,
  );
  check('failed panel offers Retry', (await page.locator('.mobile-shell__retry').count()) === 1);

  await page.unroute('**/events-finder-mobile.js*');
  await page.locator('.mobile-shell__retry').click();
  await page.waitForTimeout(5000);
  check(
    'Retry mounts the panel once the file is back',
    (await page.locator('.mobile-events__toolbar').count()) > 0 && !(await errorText()),
  );

  await openMobile();
  await page.route('**/events-filter-ui.js*', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }),
  );
  await openTab('Events');
  message = await errorText();
  check(
    'broken dependency is named, not the panel',
    /events-filter-ui\.js is missing on the server/.test(message),
    message,
  );
  await page.unroute('**/events-filter-ui.js*');

  await openMobile();
  await page.route('**/events-finder-mobile.js*', (route) =>
    route.fulfill({ status: 401, contentType: 'text/plain', body: 'Unauthorized' }),
  );
  await openTab('Events');
  message = await errorText();
  check('401 reads as an expired session', /session expired/.test(message), message);
  await page.unroute('**/events-finder-mobile.js*');

  await openMobile();
  let dropped = false;
  await page.route('**/events-finder-mobile.js*', async (route) => {
    if (!dropped) {
      dropped = true;
      await route.abort('connectionfailed');
      return;
    }
    await route.fallback();
  });
  await openTab('Events');
  check(
    'dropped request self-heals without user action',
    dropped && (await page.locator('.mobile-events__toolbar').count()) > 0 && !(await errorText()),
  );
} finally {
  await browser.close();
}

console.log(
  failures.length ? `\n${failures.length} failing check(s): ${failures.join(', ')}` : '\nall checks passed',
);
process.exit(failures.length ? 1 : 0);
