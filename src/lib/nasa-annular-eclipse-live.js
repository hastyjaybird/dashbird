/**
 * Live annular-eclipse hint for the sky strip: fetches NASA GSFC Fred Espenak
 * decade tables (HTML), parses Annular rows with [Annular: …] land paths, and
 * picks the next one whose greatest time falls within ~6 months.
 *
 * @see https://eclipse.gsfc.nasa.gov/SEdecade/SEdecade2021.html
 * Attribution: "Eclipse Predictions by Fred Espenak, NASA's GSFC" (per NASA site).
 */

const NASA_DECADE_BASE = 'https://eclipse.gsfc.nasa.gov/SEdecade/SEdecade';
const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;
const FETCH_MS = 12000;

const MONTH = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/** First calendar year in NASA “Solar Eclipses: Y–Y+9” decade page filename. */
export function nasaSolarDecadeFirstYear(utcYear) {
  const y = Number(utcYear);
  if (!Number.isFinite(y)) return 2001;
  return Math.floor((y - 1) / 10) * 10 + 1;
}

function isAntarcticaOnlyAnnularPath(bracketInner) {
  const inner = String(bracketInner || '').trim();
  if (!inner) return true;
  const parts = inner.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length !== 1) return false;
  return /^Antarctica$/i.test(parts[0]);
}

const OCEAN_SKIP = /^(Atlantic|Pacific|Indian\s+ocean|Arctic)$/i;

/**
 * @param {string} bracketInner text inside [Annular: …]
 * @returns {string[]} 1–3 short labels for the strip
 */
function topSpotsFromAnnularBracket(bracketInner) {
  const raw = String(bracketInner || '')
    .trim()
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && !OCEAN_SKIP.test(x));
  return raw.slice(0, 3);
}

/**
 * @param {string} html
 * @returns {{ greatestMs: number, title: string, topSpots: string[], forecastUrl: string, bracketInner: string }[]}
 */
export function parseNasaDecadeAnnularRows(html) {
  if (typeof html !== 'string' || html.length < 100) return [];
  const found = [];
  const chunks = html.split(/<\/tr>/i);
  for (const row of chunks) {
    if (!/>\s*Annular\s*<\/a>/i.test(row)) continue;
    const br = row.match(/\[Annular:\s*([^\]]+)\]/i);
    if (!br) continue;
    const bracketInner = br[1].trim();
    if (isAntarcticaOnlyAnnularPath(bracketInner)) continue;

    const dm = row.match(
      /target=GLOBE[^>]*>\s*(\d{4})\s+(\w{3})\s+(\d{1,2})\s*<\/a>[\s\S]*?target=ANIMATE[^>]*>\s*(\d{2}):(\d{2}):(\d{2})\s*<\/a>/i,
    );
    if (!dm) continue;
    const year = parseInt(dm[1], 10);
    const mon = MONTH[dm[2]];
    const day = parseInt(dm[3], 10);
    const hh = parseInt(dm[4], 10);
    const mm = parseInt(dm[5], 10);
    const ss = parseInt(dm[6], 10);
    if (mon == null || Number.isNaN(day) || day < 1 || day > 31) continue;

    /** TD from table — treated as UTC for dashboard ordering (ΔT small vs 6‑month gate). */
    const greatestMs = Date.UTC(year, mon, day, hh, mm, ss);
    if (Number.isNaN(greatestMs)) continue;

    const gHref = row.match(/href="(\.\.\/SEgoogle\/[^"]+)"[^>]*target=GOOGLE[^>]*>\s*Annular/i);
    let mapUrl = 'https://science.nasa.gov/eclipses/';
    if (gHref) {
      try {
        mapUrl = new URL(gHref[1], 'https://eclipse.gsfc.nasa.gov/SEdecade/').href;
      } catch {
        /* keep default */
      }
    }

    const spots = topSpotsFromAnnularBracket(bracketInner);
    if (spots.length === 0) continue;

    const title = `Annular eclipse — ${String(bracketInner).slice(0, 72)}${String(bracketInner).length > 72 ? '…' : ''}`;

    found.push({
      greatestMs,
      title,
      topSpots: spots,
      forecastUrl: mapUrl,
      bracketInner,
    });
  }
  found.sort((a, b) => a.greatestMs - b.greatestMs);
  return found;
}

async function fetchDecadeHtml(firstYear) {
  const url = `${NASA_DECADE_BASE}${firstYear}.html`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'dashbird/1.0 (NASA GSFC solar eclipse decade tables; eclipse.gsfc.nasa.gov)' },
    });
    if (!r.ok) return '';
    return await r.text();
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {Date} [now]
 * @returns {Promise<{ greatestMs: number, title: string, topSpots: string[], forecastUrl: string, bracketInner: string } | null>}
 */
export async function fetchNextLandAnnularWithinSixMonths(now = new Date()) {
  const y = now.getUTCFullYear();
  const y1 = nasaSolarDecadeFirstYear(y);
  const y2 = y1 + 10;
  const [h1, h2] = await Promise.all([fetchDecadeHtml(y1), fetchDecadeHtml(y2)]);
  const all = [...parseNasaDecadeAnnularRows(h1), ...parseNasaDecadeAnnularRows(h2)];

  const t0 = now.getTime();
  const t1 = t0 + SIX_MONTHS_MS;
  let best = null;
  for (const row of all) {
    if (row.greatestMs <= t0 || row.greatestMs > t1) continue;
    if (best == null || row.greatestMs < best.greatestMs) best = row;
  }
  return best;
}
