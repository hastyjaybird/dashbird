export function mountCalendar(root, config) {
  root.replaceChildren();
  const url = (config.calendarEmbedUrl || '').trim();
  if (config.calendarEmbedMisconfigured && !url) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent =
      'CALENDAR_EMBED_URL is set in .env but the server could not parse a usable URL. Values with & must be wrapped in double quotes, e.g. CALENDAR_EMBED_URL="https://calendar.google.com/calendar/embed?src=…&ctz=…". Restart the dashboard after editing .env.';
    root.appendChild(p);
    return;
  }
  if (!url) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent =
      'Set CALENDAR_EMBED_URL in .env to your Google Calendar iframe src URL only (not the full HTML iframe tag). If the URL contains &, wrap the whole value in double quotes in .env. Restart the server after editing .env.';
    root.appendChild(p);
    return;
  }
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.title = 'Google Calendar';
  iframe.className = 'calendar-frame__iframe';
  iframe.setAttribute('loading', 'lazy');
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  iframe.style.backgroundColor = '#0a1018';

  const frame = document.createElement('div');
  frame.className = 'calendar-frame';
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'calendar.google.com' || host === 'www.google.com' || host === 'google.com') {
      frame.classList.add('calendar-frame--google');
    }
  } catch {
    /* ignore */
  }
  frame.appendChild(iframe);
  root.appendChild(frame);
}
