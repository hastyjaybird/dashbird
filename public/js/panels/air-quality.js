const POLL_MS = 10 * 60 * 1000;
const PURPLEAIR_HOME = 'https://www.purpleair.com/map';

/**
 * @param {HTMLElement} card
 * @param {HTMLElement} mount
 * @param {object} data
 */
function applyPayload(card, mount, data) {
  const frame = mount.querySelector('.air-quality__frame');
  const iframe = mount.querySelector('.air-quality__iframe');
  const cap = mount.querySelector('.air-quality__caption');
  const status = mount.querySelector('.air-quality__status');
  if (!frame || !iframe || !cap || !status) return;

  if (data?.disabled) {
    card.hidden = true;
    return;
  }

  if (!data?.show) {
    card.hidden = true;
    iframe.removeAttribute('src');
    return;
  }

  card.hidden = false;

  const mapUrl = typeof data.mapUrl === 'string' ? data.mapUrl : '';
  if (mapUrl && iframe.getAttribute('src') !== mapUrl) {
    iframe.src = mapUrl;
  }

  const aqi = data.usAqi != null ? Math.round(Number(data.usAqi)) : null;

  if (!data.ok) {
    status.hidden = false;
    status.textContent = data.error
      ? `AQI unavailable (${data.error}). Map shown for testing.`
      : 'AQI unavailable. Map shown for testing.';
    cap.hidden = true;
    frame.hidden = false;
    iframe.hidden = false;
    return;
  }

  status.hidden = true;
  frame.hidden = false;
  iframe.hidden = false;
  cap.hidden = false;

  const zipPart = data.zip ? `ZIP ${data.zip}` : 'dashboard location';
  const cat = typeof data.category === 'string' ? data.category : '';
  const timePart =
    typeof data.timeIso === 'string' && data.timeIso
      ? new Date(data.timeIso).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : '';
  const testNote = data.forceShow && !data.aboveThreshold ? ' · testing (AQI ≤ threshold)' : '';
  const mapHref =
    typeof data.mapPageUrl === 'string' && /^https?:\/\//i.test(data.mapPageUrl)
      ? data.mapPageUrl
      : PURPLEAIR_HOME;

  cap.replaceChildren();
  const line = document.createElement('span');
  line.textContent = [
    `${zipPart} · US AQI ${aqi != null ? aqi : '—'}${cat ? ` · ${cat}` : ''}`,
    timePart ? `Open-Meteo ${timePart}` : '',
    testNote,
  ]
    .filter(Boolean)
    .join(' · ');
  cap.append(line, document.createTextNode(' '));
  const mapLink = document.createElement('a');
  mapLink.className = 'air-quality__map-link';
  mapLink.href = mapHref;
  mapLink.target = '_blank';
  mapLink.rel = 'noopener noreferrer';
  mapLink.textContent = 'Full map ↗';
  cap.append(mapLink);
}

/**
 * @param {HTMLElement | null} card
 * @param {HTMLElement | null} mount
 */
export function mountAirQuality(card, mount) {
  if (!card || !mount) return;

  mount.className = 'air-quality';
  mount.replaceChildren();

  const frame = document.createElement('div');
  frame.className = 'air-quality__frame';

  const clip = document.createElement('div');
  clip.className = 'air-quality__clip';

  const iframe = document.createElement('iframe');
  iframe.className = 'air-quality__iframe';
  iframe.title = 'Neighborhood air quality map';
  iframe.setAttribute('loading', 'lazy');
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  clip.append(iframe);
  frame.append(clip);

  const cap = document.createElement('p');
  cap.className = 'air-quality__caption';
  cap.hidden = true;

  const status = document.createElement('p');
  status.className = 'air-quality__status';
  status.textContent = 'Loading air quality…';

  mount.append(frame, cap, status);

  let pollTimer = null;

  async function refresh() {
    try {
      const r = await fetch('/api/air-quality', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok && data.ok !== false && !data.show) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      applyPayload(card, mount, data);
    } catch {
      card.hidden = false;
      status.hidden = false;
      status.textContent = 'Could not load air quality.';
      frame.hidden = true;
      cap.hidden = true;
    }
  }

  card.hidden = true;
  refresh();
  pollTimer = setInterval(refresh, POLL_MS);

  window.addEventListener('dashbird-air-quality-refresh', refresh);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    window.removeEventListener('dashbird-air-quality-refresh', refresh);
  };
}
