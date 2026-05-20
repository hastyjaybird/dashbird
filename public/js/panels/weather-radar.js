const FEED_REFRESH_MS = 10 * 60 * 1000;

/**
 * @param {HTMLElement} hostEl
 * @param {object} data
 */
function applyEmbed(hostEl, data) {
  const iframe = hostEl.querySelector('.weather-radar__iframe');
  if (!iframe) return;

  const embedUrl = typeof data.embed?.url === 'string' ? data.embed.url : '';
  if (embedUrl && iframe.getAttribute('src') !== embedUrl) {
    iframe.src = embedUrl;
  }
}

/**
 * @param {HTMLElement} hostEl
 */
function ensureEmbedDom(hostEl) {
  if (hostEl.querySelector('.weather-radar__frame')) return;

  const frame = document.createElement('div');
  frame.className = 'weather-radar__frame';

  const iframe = document.createElement('iframe');
  iframe.className = 'weather-radar__iframe';
  iframe.title = 'Live weather radar';
  iframe.setAttribute('loading', 'lazy');
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  iframe.allow = 'fullscreen';
  frame.append(iframe);

  hostEl.replaceChildren(frame);
}

/**
 * @param {object} data
 */
function radarAriaLabel(data) {
  const zip = data.embed?.zip || data.geo?.zip;
  if (zip) return `Live weather radar centered on ZIP ${zip}`;
  return 'Live weather radar';
}

/**
 * @param {HTMLElement | null} card
 * @param {HTMLElement | null} mount
 */
export function mountWeatherRadar(card, mount) {
  if (!mount || !card) return;

  const body = document.createElement('div');
  body.className = 'weather-radar__body';
  mount.append(body);

  let pollTimer = null;

  async function refresh() {
    try {
      const r = await fetch('/api/weather-radar', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }

      if (!data.show) {
        card.hidden = true;
        body.replaceChildren();
        return;
      }

      card.hidden = false;

      let mapHost = body.querySelector('.weather-radar__map-host');
      if (!mapHost) {
        mapHost = document.createElement('div');
        mapHost.className = 'weather-radar__map-host';
        body.append(mapHost);
      }

      mapHost.setAttribute('role', 'application');
      mapHost.setAttribute('aria-label', radarAriaLabel(data));

      ensureEmbedDom(mapHost);
      applyEmbed(mapHost, data);
    } catch {
      card.hidden = true;
      body.replaceChildren();
    }
  }

  refresh();
  pollTimer = setInterval(refresh, FEED_REFRESH_MS);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
  };
}
