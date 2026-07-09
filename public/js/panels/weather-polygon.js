/**
 * Rounded, layered “Fluent / Windows 11–style” weather icons (inspired by common OS weather sets).
 * Drop shadow is applied via CSS on `.fluent-weather-icon`.
 *
 * Condition image assets (clear/partly/cloudy/fog) are loaded from `/icons/weather`.
 */
const HERO_WEATHER_CLEAR_SRC = '/icons/weather/clear.png';
const HERO_WEATHER_PARTLY_SRC = '/icons/weather/partly.png';
const HERO_WEATHER_CLOUDY_SRC = '/icons/weather/cloudy.png';
const HERO_WEATHER_FOG_SRC = '/icons/weather/fog.png';
const HERO_WEATHER_RAIN_SRC = '/icons/weather/rain.png';
const HERO_WEATHER_STORM_SRC = '/icons/weather/storm.png';
const HERO_WEATHER_HEAT_ADVISORY_SRC = '/icons/weather/heat-advisory.png';

function classify(code) {
  const c = Number(code);
  if (c === 0 || c === 1) return 'clear';
  if (c === 2) return 'partly';
  if (c === 3) return 'cloudy';
  if (c === 45 || c === 48) return 'fog';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95) return 'storm';
  return 'partly';
}

function imageSvg(src, inset = 8) {
  const pad = Math.max(0, Math.min(40, Number(inset) || 0));
  const side = 128 - pad * 2;
  return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <image href="${src}" xlink:href="${src}" x="${pad}" y="${pad}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid meet"/>
  </svg>`;
}

function fogImageSvg(src) {
  return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <image href="${src}" xlink:href="${src}" x="-3" y="-3" width="134" height="134" preserveAspectRatio="xMidYMid meet"/>
  </svg>`;
}

/** Clear sun asset is wide (178×148); use full viewBox width — no inset padding. */
function clearImageSvg(src) {
  return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <image href="${src}" xlink:href="${src}" x="0" y="6" width="128" height="116" preserveAspectRatio="xMidYMid meet"/>
  </svg>`;
}

/** Partly cloudy still leads with the sun — lighter inset than other conditions. */
function partlyImageSvg(src) {
  return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <image href="${src}" xlink:href="${src}" x="2" y="4" width="124" height="120" preserveAspectRatio="xMidYMid meet"/>
  </svg>`;
}

function svg(kind) {
  switch (kind) {
    case 'heat_advisory':
      return imageSvg(HERO_WEATHER_HEAT_ADVISORY_SRC, 10);
    case 'clear':
      return clearImageSvg(HERO_WEATHER_CLEAR_SRC);
    case 'partly':
      return partlyImageSvg(HERO_WEATHER_PARTLY_SRC);
    case 'cloudy':
      return imageSvg(HERO_WEATHER_CLOUDY_SRC, 10);
    case 'fog':
      return fogImageSvg(HERO_WEATHER_FOG_SRC);
    case 'rain':
      return imageSvg(HERO_WEATHER_RAIN_SRC, 10);
    case 'snow':
      return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="56" cy="56" rx="44" ry="30" fill="#5C6BC0"/>
        <ellipse cx="82" cy="50" rx="38" ry="28" fill="#3949AB"/>
        <circle cx="42" cy="96" r="6" fill="#E1F5FE"/>
        <circle cx="64" cy="100" r="6.5" fill="#FFF"/>
        <circle cx="86" cy="96" r="6" fill="#B3E5FC"/>
      </svg>`;
    case 'storm':
      return imageSvg(HERO_WEATHER_STORM_SRC, 10);
    default: {
      return imageSvg(HERO_WEATHER_PARTLY_SRC, 10);
    }
  }
}

/** Main condition icon for the hero (large). */
export function createPolygonWeatherIcon(weatherCode, idSuffix = 'a', options = {}) {
  const kind = options?.heatAdvisory ? 'heat_advisory' : classify(weatherCode);
  const wrap = document.createElement('div');
  wrap.className = 'fluent-weather-icon poly-weather-icon';
  if (idSuffix) wrap.dataset.weatherSlot = String(idSuffix);
  wrap.innerHTML = svg(kind);
  return wrap;
}
