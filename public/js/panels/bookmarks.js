function hostnameFromHref(href) {
  try {
    const u = new URL(href);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname;
  } catch {
    return '';
  }
  return '';
}

function faviconUrl(href) {
  const host = hostnameFromHref(href);
  if (!host) return '';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/** Files were once mis-suffixed `.png` but are WebP; fix old bookmark `icon` paths. */
function normalizeTileIconPath(p) {
  const s = String(p).trim();
  if (s === '/assets/tile-google-messages.png') return '/assets/tile-google-messages.webp';
  if (s === '/assets/tile-cursor.png') return '/assets/tile-cursor.webp';
  return s;
}

function explicitBookmarkIcon(row) {
  if (!row.icon || typeof row.icon !== 'string') return null;
  const s = row.icon.trim();
  if (!s) return null;
  if (/tile-android-messages/i.test(s)) return '/assets/tile-google-messages.webp';
  return normalizeTileIconPath(s);
}

function isGoogleMessagesHttpUrl(href) {
  try {
    const u = new URL(String(href).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'messages.google.com' || host === 'www.messages.google.com';
  } catch {
    return false;
  }
}

function iconSrc(row) {
  const explicit = explicitBookmarkIcon(row);
  if (explicit) return explicit;

  const h = String(row.href || '').trim();
  if (/^cursor:/i.test(h)) return '/assets/tile-cursor.webp';
  if (/^command:/i.test(h)) return '/assets/tile-cursor.webp';
  if (/^signal:/i.test(h)) return '/assets/tile-signal.svg';
  if (/^https?:\/\/drive\.google\.com\/?/i.test(h)) return '/assets/tile-google-drive.svg';
  if (/^https?:\/\/(www\.)?calendar\.google\.com\/?/i.test(h)) return '/assets/tile-google-calendar.png';
  if (/^https?:\/\/(www\.)?keep\.google\.com\/?/i.test(h)) return '/assets/tile-google-keep.png';
  if (isGoogleMessagesHttpUrl(h)) return '/assets/tile-google-messages.webp';
  if (/^https?:\/\/(www\.)?fetlife\.com\/?/i.test(h)) return '/assets/tile-fetlife.png';
  if (/^https?:\/\/(web\.)?whatsapp\.com\/?/i.test(h)) return '/assets/tile-whatsapp.svg';
  if (/^https?:\/\/(www\.)?facebook\.com\/?/i.test(h)) return '/assets/tile-facebook.svg';
  return faviconUrl(h);
}

function isLocalLaunchHref(href) {
  const h = String(href || '').trim();
  if (/^(cursor|signal|command):/i.test(h)) return true;
  if (/^\/api\/open-desktop\//i.test(h)) return true;
  return false;
}

function fallbackGlyph(word) {
  const span = document.createElement('span');
  span.className = 'bookmark-tile__fallback';
  span.textContent = (word || '?').slice(0, 1).toUpperCase();
  return span;
}

function createTile(row) {
  const a = document.createElement('a');
  a.className = 'bookmark-tile';
  a.href = row.href;
  if (isLocalLaunchHref(row.href)) {
    a.target = '_self';
    a.rel = 'noopener';
  } else {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }

  const src = iconSrc(row);
  if (src) {
    const icon = document.createElement('img');
    icon.className = 'bookmark-tile__icon';
    icon.alt = '';
    icon.decoding = 'async';
    icon.loading = 'lazy';
    icon.src = src;
    icon.addEventListener('error', () => {
      icon.replaceWith(fallbackGlyph(row.word));
    });
    a.appendChild(icon);
  } else {
    a.appendChild(fallbackGlyph(row.word));
  }

  const word = document.createElement('span');
  word.className = 'bookmark-tile__word';
  word.textContent = String(row.word || 'Link').trim() || 'Link';

  if (row.title && typeof row.title === 'string') {
    a.title = row.title;
  }

  a.appendChild(word);
  return a;
}

function mountSections(root, data, emptyHint) {
  if (!data.sections || !Array.isArray(data.sections)) {
    root.innerHTML = `<p class="muted">${emptyHint}</p>`;
    return;
  }
  let any = false;
  let visibleSectionIndex = 0;
  for (const sec of data.sections) {
    if (!sec || typeof sec.title !== 'string' || !Array.isArray(sec.items)) continue;
    const items = sec.items.filter((row) => row && typeof row.href === 'string' && row.word != null);
    if (items.length === 0) continue;
    any = true;

    const details = document.createElement('details');
    details.className = 'bookmark-section';
    if (visibleSectionIndex === 0) {
      details.open = true;
    }
    visibleSectionIndex += 1;

    const summary = document.createElement('summary');
    summary.className = 'bookmark-section-summary';
    summary.textContent = sec.title;

    const grid = document.createElement('div');
    grid.className = 'bookmark-section-grid';
    for (const row of items) {
      grid.appendChild(createTile(row));
    }
    details.append(summary, grid);
    root.appendChild(details);
  }
  if (!any) {
    root.innerHTML = `<p class="muted">${emptyHint}</p>`;
  }
}

/**
 * @param {HTMLElement} root
 * @param {string} dataPath
 * @param {string} emptyHint
 */
export async function mountBookmarkGrid(root, dataPath, emptyHint) {
  root.dataset.bookmarkPath = dataPath;
  root.replaceChildren();
  const r = await fetch(dataPath, { cache: 'no-store' });
  if (!r.ok) {
    root.innerHTML = `<p class="muted">${emptyHint}</p>`;
    return;
  }
  let data;
  try {
    data = await r.json();
  } catch {
    root.innerHTML = '<p class="muted">Invalid JSON in bookmark file.</p>';
    return;
  }

  if (data && Array.isArray(data.sections)) {
    mountSections(root, data, emptyHint);
    return;
  }

  /* Legacy: flat array of { word, href } */
  if (Array.isArray(data) && data.length > 0) {
    const grid = document.createElement('div');
    grid.className = 'bookmark-section-grid';
    for (const row of data) {
      if (!row?.href || row.word == null) continue;
      grid.appendChild(createTile(row));
    }
    if (grid.childElementCount === 0) {
      root.innerHTML = `<p class="muted">${emptyHint}</p>`;
    } else {
      root.appendChild(grid);
    }
    return;
  }

  root.innerHTML = `<p class="muted">${emptyHint}</p>`;
}
