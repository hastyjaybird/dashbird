const FEED_REFRESH_MS = 10 * 60 * 1000;
const WINDY_HOME = 'https://www.windy.com/';

/**
 * @param {HTMLElement} hostEl
 * @param {object} data
 */
function applyEmbed(hostEl, data) {
  const iframe = hostEl.querySelector('.weather-radar__iframe');
  const cap = hostEl.querySelector('.weather-radar__caption');
  if (!iframe) return;

  const embedUrl = typeof data.embed?.url === 'string' ? data.embed.url : '';
  if (embedUrl && iframe.getAttribute('src') !== embedUrl) {
    iframe.src = embedUrl;
  }

  if (cap) {
    const msg = typeof data.message === 'string' ? data.message.trim() : '';
    const href =
      typeof data.embed?.mapPageUrl === 'string' && /^https?:\/\//i.test(data.embed.mapPageUrl)
        ? data.embed.mapPageUrl
        : WINDY_HOME;
    cap.replaceChildren();
    if (msg) {
      cap.append(document.createTextNode(`${msg} · `));
    }
    const link = document.createElement('a');
    link.className = 'weather-radar__map-link';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Windy radar ↗';
    cap.append(link);
    cap.hidden = false;
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

  const cap = document.createElement('p');
  cap.className = 'weather-radar__caption';
  cap.hidden = true;

  hostEl.replaceChildren(frame, cap);
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

  const status = document.createElement('p');
  status.className = 'weather-radar__status';
  status.hidden = true;
  mount.append(status);

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
        status.hidden = true;
        return;
      }

      card.hidden = false;
      status.hidden = true;

      let mapHost = body.querySelector('.weather-radar__map-host');
      if (!mapHost) {
        mapHost = document.createElement('div');
        mapHost.className = 'weather-radar__map-host';
        body.append(mapHost);
      }

      const msg = typeof data.message === 'string' ? data.message.trim() : '';
      mapHost.setAttribute('role', 'application');
      mapHost.setAttribute(
        'aria-label',
        msg ? `${msg} — Windy radar` : 'Live weather radar from Windy',
      );

      ensureEmbedDom(mapHost);
      applyEmbed(mapHost, data);
    } catch {
      card.hidden = true;
      status.hidden = true;
      status.textContent = '';
      body.replaceChildren();
    }
  }

  refresh();
  pollTimer = setInterval(refresh, FEED_REFRESH_MS);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
  };
}
