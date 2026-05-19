/**
 * Startup / periodic fetch: infer US state from dashboard location, pull DesertUSA
 * state wildflower page (CA, AZ, NV, TX, NM), extract region hints + coarse bloom sentiment.
 * Heuristic only — not a botanical guarantee.
 */
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';

const UA =
  process.env.SUPERBLOOM_FETCH_UA ||
  'dashbird/1.0 (personal dashboard; DesertUSA wildflower summary bot)';

const DESERTUSA_STATES = new Set(['CA', 'AZ', 'NV', 'TX', 'NM']);

/** Substrings matched case-insensitively in page text → reported regions. */
const REGION_HINTS = {
  CA: [
    'Anza-Borrego',
    'Borrego Springs',
    'Death Valley',
    'Antelope Valley',
    'Poppy Reserve',
    'Joshua Tree',
    'Mojave',
    'Carrizo',
    'Owens Valley',
    'Eastern Sierra',
    'Coachella',
    'Sonoran',
    'Imperial Valley',
    'Channel Islands',
    'Red Rock Canyon',
    'Mojave National Preserve',
  ],
  AZ: [
    'Picacho Peak',
    'Picacho',
    'Superstition',
    'Organ Pipe',
    'Catalina State Park',
    'Saguaro',
    'Sonoran Desert',
    'Phoenix',
    'Tucson',
    'Apache Trail',
    'Eloy',
    'Globe',
  ],
  NV: [
    'Lake Mead',
    'Valley of Fire',
    'Red Rock Canyon',
    'Mojave Desert',
    'Great Basin',
    'Reno',
    'Las Vegas',
    'Amargosa',
    'Ash Meadows',
  ],
  TX: [
    'Big Bend',
    'Chihuahuan',
    'El Paso',
    'Trans-Pecos',
    'Guadalupe Mountains',
    'Marathon',
    'Lajitas',
  ],
  NM: [
    'Carlsbad',
    'White Sands',
    'Chihuahuan',
    'Organ Mountains',
    'Lincoln National Forest',
    'Socorro',
    'Albuquerque',
  ],
};

const POS_RE =
  /\b(super[\s-]?bloom|spectacular|excellent|peak\s+bloom|widespread|blanket|carpet|abundant|heavy\s+bloom|significant\s+bloom|good\s+bloom|decent\s+bloom)\b/gi;

const NEG_RE =
  /\b(no\s+bloom|poor\s+bloom|minimal|sparse|drought|little\s+rain|below\s+average|barely\s+any|not\s+much\s+bloom|essentially\s+no\s+bloom|challenging.*\s+bloom|very\s+low\s+overall)\b/gi;

const HTML_STRIP_RE = /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi;

/** @type {object | null} */
let cache = null;

/** @type {Promise<object> | null} */
let inFlight = null;

function stripHtml(html) {
  return String(html)
    .replace(HTML_STRIP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countRegexMatches(re, text) {
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * @param {string} abbrev 2-letter
 * @param {string} text normalized page text (length capped)
 */
function findRegions(abbrev, text) {
  const hints = REGION_HINTS[abbrev] || [];
  const lower = text.toLowerCase();
  /** @type {string[]} */
  const found = [];
  for (const h of hints) {
    if (lower.includes(h.toLowerCase())) found.push(h);
  }
  return [...new Set(found)].slice(0, 12);
}

/**
 * @param {number} pos
 * @param {number} neg
 */
function assessBloom(pos, neg) {
  if (pos === 0 && neg === 0) return 'unknown';
  if (pos >= 2 && neg === 0) return 'likely_active';
  if (neg >= 2 && pos === 0) return 'likely_quiet';
  if (pos > 0 && neg > 0) return 'mixed';
  if (pos >= 1) return 'possible_activity';
  return 'likely_quiet';
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{ stateAbbrev: string, stateName: string } | null>}
 */
async function stateFromNominatim(lat, lon) {
  const u = new URL('https://nominatim.openstreetmap.org/reverse');
  u.searchParams.set('lat', String(lat));
  u.searchParams.set('lon', String(lon));
  u.searchParams.set('format', 'json');
  const signal = AbortSignal.timeout(14_000);
  const r = await fetch(u.toString(), {
    signal,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
    },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const a = j?.address;
  if (!a) return null;
  const iso = a['ISO3166-2-lvl4'];
  let abbrev =
    typeof iso === 'string' && /^US-[A-Z]{2}$/i.test(iso) ? iso.slice(3).toUpperCase() : '';
  const stateName = typeof a.state === 'string' ? a.state : '';
  if (!abbrev && stateName) {
    /** Very small fallback if ISO missing. */
    const map = {
      California: 'CA',
      Arizona: 'AZ',
      Nevada: 'NV',
      Texas: 'TX',
      'New Mexico': 'NM',
    };
    abbrev = map[stateName] || '';
  }
  if (!abbrev || abbrev.length !== 2) return null;
  return { stateAbbrev: abbrev, stateName };
}

/**
 * @param {string} stateAbbrev
 */
function buildSummary(stateAbbrev, assessment, regions) {
  const regionPhrase =
    regions.length > 0
      ? `Mentions include ${regions.slice(0, 6).join(', ')}${regions.length > 6 ? ', …' : ''}.`
      : 'No named desert regions were matched in the scraped text.';

  const mood =
    assessment === 'likely_active'
      ? 'Language on the page leans toward strong or notable blooming activity.'
      : assessment === 'likely_quiet'
        ? 'Language on the page leans toward poor or minimal blooming.'
        : assessment === 'mixed'
          ? 'The page mixes positive and negative bloom wording (typical in regional roundups).'
          : assessment === 'possible_activity'
            ? 'Some positive bloom-related wording appears; certainty is low.'
            : 'Bloom status is unclear from keyword scan alone.';

  return `DesertUSA ${stateAbbrev} wildflower digest (${mood}) ${regionPhrase} Verify on the source page before traveling.`;
}

async function fetchDesertUsaStateHtml(stateAbbrev) {
  const url = `https://www.desertusa.com/wildflo/${stateAbbrev.toLowerCase()}.html`;
  const signal = AbortSignal.timeout(22_000);
  const r = await fetch(url, {
    signal,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`DesertUSA HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const cap = Math.min(buf.byteLength, 480_000);
  const slice = buf.slice(0, cap);
  return { html: new TextDecoder('utf-8', { fatal: false }).decode(slice), url };
}

/**
 * @returns {Promise<object>}
 */
export async function refreshSuperbloomCache() {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const out = {
      ok: true,
      updatedAt: new Date().toISOString(),
      stateAbbrev: '',
      stateName: '',
      regions: /** @type {string[]} */ ([]),
      assessment: 'unknown',
      summary: '',
      sourceUrl: null,
      note: 'Heuristic summary from public desert wildflower page text; not real-time field surveys.',
    };

    try {
      const { lat, lon, stateAbbrev: fromZip, stateName: nameFromZip } =
        await resolveDashboardWeatherLatLon();

      let abbrev = (fromZip || '').trim().toUpperCase();
      let stateName = (nameFromZip || '').trim();

      if (!abbrev || abbrev.length !== 2) {
        const geo = await stateFromNominatim(lat, lon);
        if (geo) {
          abbrev = geo.stateAbbrev;
          stateName = geo.stateName || stateName;
        }
      }

      out.stateAbbrev = abbrev;
      out.stateName = stateName;

      if (!abbrev || abbrev.length !== 2) {
        out.ok = true;
        out.assessment = 'unknown';
        out.summary = 'Could not resolve a US state from ZIP or coordinates (try WEATHER_ZIP or valid WEATHER_LAT/LON).';
        cache = out;
        return out;
      }

      if (!DESERTUSA_STATES.has(abbrev)) {
        out.assessment = 'out_of_scope';
        out.summary = `No DesertUSA "wildflo" digest for ${abbrev}. This agent only auto-pulls desert wildflower roundups for CA, AZ, NV, TX, and NM.`;
        cache = out;
        return out;
      }

      const { html, url } = await fetchDesertUsaStateHtml(abbrev);
      out.sourceUrl = url;
      const text = stripHtml(html).slice(0, 120_000);
      const pos = countRegexMatches(POS_RE, text);
      const neg = countRegexMatches(NEG_RE, text);
      out.regions = findRegions(abbrev, text);
      out.assessment = assessBloom(pos, neg);
      out.summary = buildSummary(abbrev, out.assessment, out.regions);
      cache = out;
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errOut = {
        ...out,
        ok: false,
        assessment: 'error',
        summary: `Superbloom fetch failed: ${msg}`,
        sourceUrl: out.sourceUrl,
      };
      cache = errOut;
      return errOut;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function getSuperbloomCache() {
  return cache;
}

export function startSuperbloomAgent() {
  refreshSuperbloomCache().catch((e) => console.error('[superbloom agent]', e));
  const raw = process.env.SUPERBLOOM_REFRESH_MS;
  const ms = raw != null && String(raw).trim() !== '' ? Number.parseInt(String(raw), 10) : 24 * 3600 * 1000;
  if (Number.isFinite(ms) && ms >= 60_000) {
    setInterval(() => {
      refreshSuperbloomCache().catch((e) => console.error('[superbloom refresh]', e));
    }, ms);
  }
}
