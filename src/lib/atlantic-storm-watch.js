const NHC_CURRENT_STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const NHC_USER_AGENT = 'Dashbird/1.0 (dashbird dashboard; atlantic storm watch)';

const LAND_IMPACT_HINT_RE =
  /\b(landfall|move inland|moving inland|inland|coast|coastal|shore|hurricane warning|hurricane watch|tropical storm warning|tropical storm watch|storm surge warning|storm surge watch)\b/i;
const PUERTO_RICO_HINT_RE = /\bpuerto\s+rico\b/i;

const LANDFALL_LOCATION_PATTERNS = [
  /\b(?:make\s+)?landfall\s+(?:on|in|along|near|over|across)\s+(?:the\s+)?(?:(?:east|west|north|south|northeast|northwest|southeast|southwest)\s+)?(?:coast\s+of\s+)?([A-Za-z][A-Za-z\s.'-]{1,50}?)(?=\s+(?:in|within|about|by|on|as|with|and|before|later)|[.,;]|$)/i,
  /\b(?:is\s+)?expected\s+to\s+move\s+(?:near|along|over)\s+(?:or\s+(?:near|over)\s+)?(?:the\s+)?(?:(?:east|west|north|south|northeast|northwest|southeast|southwest)\s+)?coast\s+of\s+([A-Za-z][A-Za-z\s.'-]{1,50}?)(?=\s+(?:in|within|about|by|on|as|with|and|before|later|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)|[.,;]|$)/i,
  /\bmove\s+inland\s+over\s+([A-Za-z][A-Za-z\s.'-]{1,40}?)(?=[.,;]|$)/i,
  /\bnear\s+the\s+coast\s+of\s+([A-Za-z][A-Za-z\s.'-]{1,40}?)(?=[.,;]|$)/i,
  /\b(?:north|south|east|west|northeast|northwest|southeast|southwest)\s+coast\s+of\s+([A-Za-z][A-Za-z\s.'-]{1,40}?)(?=\s+(?:in|at|through|later|today|tonight|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)|[.,;]|$)/i,
];

export { NHC_CURRENT_STORMS_URL };

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isAtlanticStorm(storm) {
  const bin = String(storm?.binNumber || '').toUpperCase().trim();
  const id = String(storm?.id || '').toLowerCase().trim();
  return bin.startsWith('AT') || id.startsWith('al');
}

function isCatOneOrHigher(storm) {
  const cls = String(storm?.classification || '').toUpperCase().trim();
  if (cls === 'HU') return true;
  const kt = asNumber(storm?.intensity);
  return kt != null && kt >= 64;
}

function advisoryTextUrls(storm) {
  const bases = [
    storm?.publicAdvisory?.url,
    storm?.forecastDiscussion?.url,
    storm?.forecastAdvisory?.url,
    storm?.windSpeedProbabilities?.url,
  ];
  const out = [];
  for (const raw of bases) {
    const u = String(raw || '').trim();
    if (!/^https?:\/\//i.test(u)) continue;
    const withText = u.includes('?') ? u : u.endsWith('.shtml') ? `${u}?text` : u;
    if (!out.includes(withText)) out.push(withText);
  }
  return out;
}

function primaryForecastUrl(storm) {
  const urls = advisoryTextUrls(storm);
  if (urls.length) return urls[0].replace(/\?text$/, '');
  return 'https://www.nhc.noaa.gov/';
}

function normalizeText(raw) {
  const s = String(raw || '');
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAdvisoryBody(raw) {
  const pre = String(raw || '').match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  return normalizeText(pre?.[1] ?? raw);
}

export async function fetchAdvisoryText(urls, fetchImpl = fetch) {
  const chunks = [];
  for (const url of urls) {
    try {
      const r = await fetchImpl(url, {
        redirect: 'follow',
        headers: { 'User-Agent': NHC_USER_AGENT, Accept: 'text/html,text/plain' },
      });
      if (!r.ok) continue;
      chunks.push(extractAdvisoryBody(await r.text()));
    } catch {
      // Try next advisory source.
    }
  }
  return chunks.join(' ');
}

function extractLandImpactLine(txt) {
  const s = String(txt || '');
  if (!s) return '';
  const parts = s.split(/(?<=[.?!])\s+/);
  for (const part of parts) {
    if (LAND_IMPACT_HINT_RE.test(part)) return part.trim();
  }
  return '';
}

function saffirSimpsonCategory(storm) {
  const kt = asNumber(storm?.intensity);
  if (kt == null || kt < 64) return null;
  if (kt >= 137) return 5;
  if (kt >= 113) return 4;
  if (kt >= 96) return 3;
  if (kt >= 83) return 2;
  return 1;
}

function extractForecastDays(txt) {
  const m = String(txt || '').match(/\b(?:in|within|about)\s+(\d{1,2})\s+days?\b/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanLandfallLocation(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/\s+(?:in|within|about|by)\s+.*$/i, '').trim();
  s = s
    .replace(
      /\s+(?:on|tonight|today|late|early|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday).*$/i,
      '',
    )
    .trim();
  return s;
}

function landfallSentencePriority(part) {
  if (/\b(?:is\s+)?expected\s+to\s+(?:make\s+)?landfall\b/i.test(part)) return 0;
  if (/\b(?:is\s+)?expected\s+to\s+move\b/i.test(part)) return 1;
  if (/\blandfall\b/i.test(part)) return 2;
  if (/\bheading\s+for\b/i.test(part)) return 3;
  if (/\bforecast\s+track\b/i.test(part)) return 4;
  if (/\bexpected\b/i.test(part)) return 5;
  if (/\bforecast\b/i.test(part)) return 6;
  return 9;
}

export function extractLandfallLocation(txt) {
  const s = String(txt || '');
  const focused = s
    .split(/(?<=[.?!])\s+/)
    .filter((part) => /\b(expected|forecast|landfall|forecast track|heading for)\b/i.test(part));

  const searchSpaces = focused.length
    ? [...focused].sort((a, b) => landfallSentencePriority(a) - landfallSentencePriority(b))
    : [s];
  for (const chunk of searchSpaces) {
    for (const re of LANDFALL_LOCATION_PATTERNS) {
      const m = chunk.match(re);
      if (!m?.[1]) continue;
      const loc = cleanLandfallLocation(m[1]);
      if (loc.length >= 3) return loc;
    }
  }

  for (const re of LANDFALL_LOCATION_PATTERNS) {
    const m = s.match(re);
    if (!m?.[1]) continue;
    const loc = cleanLandfallLocation(m[1]);
    if (loc.length >= 3) return loc;
  }
  return null;
}

export function landfallForecastDetailLine(advisoryText) {
  const location = extractLandfallLocation(advisoryText);
  const days = extractForecastDays(advisoryText);
  const timing = days != null ? ` (${days} days)` : '';
  if (location) return `Forecasted landfall: ${location}${timing}.`;
  if (days != null) return `Forecasted landfall${timing}.`;
  return 'Forecasted landfall in current advisory.';
}

export function stormQualifiesForEarthStrip(storm) {
  return isAtlanticStorm(storm) && isCatOneOrHigher(storm);
}

export function buildStormEarthItem(storm, advisoryText) {
  const hasProjectedLandImpact = LAND_IMPACT_HINT_RE.test(advisoryText);
  if (!hasProjectedLandImpact) return null;

  const cat = saffirSimpsonCategory(storm);
  const catLabel = cat != null ? `Cat ${cat}` : 'Hurricane-force';
  const name = String(storm?.name || 'Atlantic storm').trim() || 'Atlantic storm';
  const prRisk = PUERTO_RICO_HINT_RE.test(advisoryText);
  const landfallLocation = extractLandfallLocation(advisoryText);
  const forecastDays = extractForecastDays(advisoryText);
  const impactSnippet = extractLandImpactLine(advisoryText);
  const detailParts = [`${catLabel} (${asNumber(storm?.intensity) ?? '?'} kt)`];
  if (landfallLocation || forecastDays != null) {
    detailParts.push(landfallForecastDetailLine(advisoryText));
  } else if (impactSnippet) {
    detailParts.push(impactSnippet);
  } else {
    detailParts.push('Projected land impact in current advisory');
  }

  return {
    earthType: 'atlantic_cyclone_land_impact',
    label: name,
    detailLine: detailParts.join(' · '),
    forecastUrl: primaryForecastUrl(storm),
    stormId: String(storm?.id || ''),
    advisoryIssuedAt:
      typeof storm?.publicAdvisory?.issuance === 'string' ? storm.publicAdvisory.issuance : null,
    puertoRicoRisk: prRisk,
    landfallLocation,
  };
}

/**
 * @param {object[]} activeStorms NHC `activeStorms` array
 * @param {typeof fetch} [fetchImpl]
 */
export async function buildAtlanticStormEarthItems(activeStorms, fetchImpl = fetch) {
  const qualifying = (Array.isArray(activeStorms) ? activeStorms : []).filter((s) =>
    stormQualifiesForEarthStrip(s),
  );
  const items = [];

  for (const storm of qualifying) {
    const advisoryText = await fetchAdvisoryText(advisoryTextUrls(storm), fetchImpl);
    const item = buildStormEarthItem(storm, advisoryText);
    if (item) items.push(item);
  }

  return { items, scanned: qualifying.length };
}
