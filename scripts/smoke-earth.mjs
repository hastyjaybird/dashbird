#!/usr/bin/env node
/**
 * Smoke test: Earth sidebar data sources (monarchs, NPN spring, tarantulas, salamanders, salmon, wild foraging, USGS quake week, GOES GLM lightning).
 *
 * Usage:
 *   node scripts/smoke-earth.mjs [baseUrl]
 *
 * Examples:
 *   node scripts/smoke-earth.mjs
 *   node scripts/smoke-earth.mjs http://127.0.0.1:3000
 *
 * Expects a running dashbird server (same .env as production for realistic values).
 */
import 'dotenv/config';

const base = (process.argv[2] || process.env.BASE_URL || buildDefaultBase()).replace(/\/$/, '');

function buildDefaultBase() {
  const p = process.env.HOST_PORT || process.env.PORT || '3000';
  return `http://127.0.0.1:${p}`;
}

const PATHS = [
  { name: 'earth-events (monarch)', path: '/api/earth-events' },
  { name: 'usa-npn-spring', path: '/api/usa-npn-spring' },
  { name: 'yosemite-moonbow (sky strip)', path: '/api/yosemite-moonbow' },
  { name: 'diablo-tarantula', path: '/api/diablo-tarantula' },
  { name: 'oakland-salamanders', path: '/api/oakland-salamanders' },
  { name: 'salmon-runs', path: '/api/salmon-runs' },
  { name: 'wild-foraging', path: '/api/wild-foraging' },
  { name: 'nasturtium-bloom', path: '/api/nasturtium-bloom' },
  { name: 'dashboard-earthquake-week', path: '/api/dashboard-earthquake-week' },
  { name: 'dashboard-lightning-glm', path: '/api/dashboard-lightning-glm' },
];

function trunc(s, n = 48) {
  const t = String(s ?? '');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function cell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * @param {string} path
 */
async function fetchJson(path) {
  const url = `${base}${path}`;
  const r = await fetch(url, { cache: 'no-store' });
  let json;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { url, status: r.status, json };
}

let failed = false;
/** @type {Record<string, string>[]} */
const summaryRows = [];
/** @type {Record<string, string>[]} */
const itemRows = [];

console.log(`Base: ${base}\n`);

for (const { name, path } of PATHS) {
  const row = {
    API: name,
    Path: path,
    HTTP: '',
    ok: '',
    items: '',
    notes: '',
  };
  try {
    const { url, status, json } = await fetchJson(path);
    row.HTTP = String(status);
    row.ok = json && typeof json.ok !== 'undefined' ? String(json.ok) : '(no json)';
    const items = Array.isArray(json?.items) ? json.items : null;
    row.items = items ? String(items.length) : '—';

    if (status < 200 || status >= 300) {
      failed = true;
      row.notes = trunc(json?.error || 'bad status', 72);
    } else if (json?.ok === false) {
      failed = true;
      row.notes = trunc(json?.error || 'ok:false', 72);
    } else {
      const bits = [];
      if (json?.locationLabel) bits.push(`locationLabel=${trunc(json.locationLabel, 36)}`);
      if (json?.timeZone) bits.push(`timeZone=${json.timeZone}`);
      if (json?.dateEvaluated) bits.push(`dateEvaluated=${trunc(json.dateEvaluated, 28)}`);
      if (json?.month != null) bits.push(`month=${json.month}`);
      if (json?.radiusMiles != null) bits.push(`radiusMiles=${json.radiusMiles}`);
      if (json?.nativeRadiusMiles != null) bits.push(`nativeRadiusMiles=${json.nativeRadiusMiles}`);
      if (json?.fallingFruit) bits.push(`FF.configured=${json.fallingFruit.configured}`);
      if (json?.earthDebugShowInactive === true) bits.push('earthDebug=on');
      if (json?.summary) {
        const sp = json.summary.spring?.status;
        const fa = json.summary.fall?.status;
        bits.push(`spring=${sp == null ? 'null' : String(sp)}`);
        bits.push(`fall=${fa == null ? 'null' : String(fa)}`);
      }
      row.notes = bits.join(' · ') || '—';
    }

    const okLine = status >= 200 && status < 300 && json?.ok !== false;
    console.log(`${okLine ? 'OK  ' : 'FAIL'} ${name}`);
    console.log(`      ${url}`);
    if (items && items.length > 0) {
      items.slice(0, 3).forEach((it, i) => {
        console.log(`      [${i}] ${it.earthType || '—'} | ${trunc(it.label, 64)}`);
      });
      if (items.length > 3) console.log(`      … ${items.length - 3} more row(s)`);
    } else if (items) {
      console.log('      (no items)');
    }

    if (items) {
      items.forEach((it, i) => {
        itemRows.push({
          API: name,
          '#': String(i + 1),
          earthType: cell(it.earthType),
          label: cell(trunc(it.label, 56)),
          detailLine: cell(trunc(it.detailLine, 72)),
          forecastUrl: it.forecastUrl ? 'yes' : 'no',
        });
      });
    }
  } catch (e) {
    failed = true;
    row.HTTP = '—';
    row.ok = '—';
    row.items = '—';
    row.notes = trunc(e?.message || e, 72);
    console.error(`FAIL ${name} —`, row.notes);
  }
  summaryRows.push(row);
}

console.log('\n--- Summary table ---\n');
printMarkdownTable(
  ['API', 'Path', 'HTTP', 'ok', 'items', 'notes'],
  ['API', 'Path', 'HTTP', 'ok', 'items', 'notes'].map((k) => summaryRows.map((r) => r[k])),
);

if (itemRows.length > 0) {
  console.log('\n--- Items returned (Earth-related APIs) ---\n');
  printMarkdownTable(
    ['API', '#', 'earthType', 'label', 'detailLine', 'forecastUrl'],
    ['API', '#', 'earthType', 'label', 'detailLine', 'forecastUrl'].map((k) => itemRows.map((r) => r[k])),
  );
} else {
  console.log('\n--- Items table ---\n(no items in any response)\n');
  console.log(
    'Why the items table can be empty (APIs still return ok:true and the summary table above still applies):\n',
  );
  console.log(
    '  • earth-events: strip rows only when monarch model is “clustering” or “peak_presence”.',
  );
  console.log(
    '    If spring/fall status in the summary table is “null”, likelihood is below the UI threshold — items [].',
  );
  console.log(
    '    Set EARTH_DEBUG_SHOW_INACTIVE=1 to still get two monarch rows (inactive) with % scores.',
  );
  console.log(
    '    Or try: ?date=2024-09-15 for another calendar day in your WEATHER_TIME_ZONE.\n',
  );
  console.log(
    '  • salmon-runs: only months + sites inside SALMON_RUN_RADIUS_MI; inland or “off” months → [].',
  );
  console.log('    Set EARTH_DEBUG_SHOW_INACTIVE=1 to include out-of-month runs (salmon_run_offseason).\n');
  console.log(
    '  • wild-foraging: native rows need a regional site + active month inside EDIBLE_NATIVE_PLANT_RADIUS_MI;',
  );
  console.log(
    '    Falling Fruit rows need FALLING_FRUIT_API_KEY and nearby mapped points within FALLING_FRUIT_MAX_DISTANCE_M.',
  );
  console.log(
    '    Set EARTH_DEBUG_SHOW_INACTIVE=1 for wild_edible_offseason rows and higher row caps.\n',
  );
}

process.exit(failed ? 1 : 0);

/**
 * @param {string[]} headers
 * @param {string[][]} columns
 */
function printMarkdownTable(headers, columns) {
  const n = columns[0]?.length ?? 0;
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(columns.map((col) => col[i] ?? ''));
  }
  console.log(`| ${headers.join(' | ')} |`);
  console.log(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const r of rows) {
    console.log(`| ${r.join(' | ')} |`);
  }
}
