/**
 * Rounded, layered “Fluent / Windows 11–style” weather icons (inspired by common OS weather sets).
 * Drop shadow is applied via CSS on `.fluent-weather-icon`.
 */
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

function safeSuffix(s) {
  return String(s || 'x').replace(/[^a-zA-Z0-9_-]/g, '') || 'x';
}

function svg(kind, s) {
  const sunG = `sun_${s}`;
  const sunY = `suny_${s}`;
  switch (kind) {
    case 'clear':
      return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="${sunG}" cx="40%" cy="35%" r="65%">
            <stop offset="0%" stop-color="#FFF9C4"/>
            <stop offset="45%" stop-color="#FFCA28"/>
            <stop offset="100%" stop-color="#FFA000"/>
          </radialGradient>
          <radialGradient id="${sunY}" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#FFE082" stop-opacity="0.55"/>
            <stop offset="100%" stop-color="#FF8F00" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <circle cx="64" cy="64" r="46" fill="url(#${sunY})"/>
        <circle cx="64" cy="64" r="30" fill="url(#${sunG})"/>
        <circle cx="64" cy="64" r="20" fill="#FFFDE7" opacity="0.65"/>
        <g fill="#FFCA28" opacity="0.95">
          <circle cx="64" cy="18" r="6"/><circle cx="92" cy="30" r="5.5"/><circle cx="106" cy="58" r="5.5"/>
          <circle cx="100" cy="90" r="5.5"/><circle cx="64" cy="110" r="6"/><circle cx="28" cy="90" r="5.5"/>
          <circle cx="22" cy="58" r="5.5"/><circle cx="36" cy="30" r="5.5"/>
        </g>
      </svg>`;
    case 'partly':
      return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="${sunG}" cx="40%" cy="35%" r="65%">
            <stop offset="0%" stop-color="#FFF9C4"/>
            <stop offset="50%" stop-color="#FFCA28"/>
            <stop offset="100%" stop-color="#FB8C00"/>
          </radialGradient>
        </defs>
        <circle cx="86" cy="44" r="26" fill="url(#${sunG})"/>
        <circle cx="86" cy="44" r="17" fill="#FFF9C4" opacity="0.55"/>
        <ellipse cx="48" cy="88" rx="40" ry="26" fill="#64B5F6"/>
        <ellipse cx="72" cy="82" rx="44" ry="30" fill="#42A5F5"/>
        <ellipse cx="92" cy="90" rx="28" ry="20" fill="#1E88E5"/>
      </svg>`;
    case 'cloudy':
      return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="44" cy="72" rx="42" ry="28" fill="#64B5F6"/>
        <ellipse cx="78" cy="64" rx="46" ry="32" fill="#42A5F5"/>
        <ellipse cx="96" cy="78" rx="30" ry="22" fill="#1E88E5"/>
      </svg>`;
    case 'fog':
      return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="64" cy="58" rx="48" ry="26" fill="#64B5F6"/>
        <ellipse cx="72" cy="52" rx="40" ry="22" fill="#90CAF9"/>
        <rect x="8" y="86" width="112" height="8" rx="4" fill="#B3E5FC" opacity="0.85"/>
        <rect x="16" y="100" width="96" height="7" rx="3.5" fill="#E1F5FE" opacity="0.7"/>
        <rect x="24" y="112" width="80" height="6" rx="3" fill="#B2EBF2" opacity="0.55"/>
      </svg>`;
    case 'rain':
      return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="52" cy="58" rx="44" ry="30" fill="#5C6BC0"/>
        <ellipse cx="80" cy="52" rx="42" ry="30" fill="#3949AB"/>
        <ellipse cx="96" cy="66" rx="26" ry="20" fill="#283593"/>
        <path d="M36 92 Q38 108 32 118" stroke="#81D4FA" stroke-width="9" stroke-linecap="round" fill="none"/>
        <path d="M58 90 Q60 106 54 118" stroke="#4FC3F7" stroke-width="9" stroke-linecap="round" fill="none"/>
        <path d="M80 92 Q82 108 76 118" stroke="#B3E5FC" stroke-width="9" stroke-linecap="round" fill="none"/>
      </svg>`;
    case 'snow':
      return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="56" cy="56" rx="44" ry="30" fill="#5C6BC0"/>
        <ellipse cx="82" cy="50" rx="38" ry="28" fill="#3949AB"/>
        <circle cx="42" cy="96" r="6" fill="#E1F5FE"/>
        <circle cx="64" cy="100" r="6.5" fill="#FFF"/>
        <circle cx="86" cy="96" r="6" fill="#B3E5FC"/>
      </svg>`;
    case 'storm':
      return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="54" cy="56" rx="46" ry="32" fill="#4A148C"/>
        <ellipse cx="84" cy="50" rx="40" ry="30" fill="#6A1B9A"/>
        <ellipse cx="100" cy="64" rx="22" ry="18" fill="#311B92"/>
        <path d="M52 78 L44 102 H58 L50 118 L72 88 H56 L64 78 Z" fill="#FFEB3B" stroke="#F9A825" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M70 92 Q72 108 66 118" stroke="#81D4FA" stroke-width="7" stroke-linecap="round" fill="none"/>
      </svg>`;
    default: {
      const pg = `sun_${s}`;
      return `<svg class="fluent-svg" viewBox="0 0 128 128" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="${pg}" cx="40%" cy="35%" r="65%">
            <stop offset="0%" stop-color="#FFF9C4"/>
            <stop offset="50%" stop-color="#FFCA28"/>
            <stop offset="100%" stop-color="#FB8C00"/>
          </radialGradient>
        </defs>
        <circle cx="86" cy="44" r="26" fill="url(#${pg})"/>
        <circle cx="86" cy="44" r="17" fill="#FFF9C4" opacity="0.55"/>
        <ellipse cx="48" cy="88" rx="40" ry="26" fill="#64B5F6"/>
        <ellipse cx="72" cy="82" rx="44" ry="30" fill="#42A5F5"/>
        <ellipse cx="92" cy="90" rx="28" ry="20" fill="#1E88E5"/>
      </svg>`;
    }
  }
}

/** Main condition icon for the hero (large). */
export function createPolygonWeatherIcon(weatherCode, idSuffix = 'a') {
  const kind = classify(weatherCode);
  const s = safeSuffix(idSuffix);
  const wrap = document.createElement('div');
  wrap.className = 'fluent-weather-icon poly-weather-icon';
  wrap.innerHTML = svg(kind, s);
  return wrap;
}
