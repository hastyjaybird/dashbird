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

function iconSrc(row) {
  if (row.icon && typeof row.icon === 'string') return row.icon;
  const h = row.href || '';
  if (/^cursor:/i.test(h)) return '/assets/tile-cursor.webp';
  if (/^signal:/i.test(h)) return '/assets/tile-signal.svg';
  if (/^https?:\/\/drive\.google\.com\/?/i.test(h)) return '/assets/tile-google-drive.svg';
  return faviconUrl(h);
}

function isLikelyCustomProtocol(href) {
  return /^(cursor|signal):/i.test(href || '');
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
  if (isLikelyCustomProtocol(row.href)) {
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
