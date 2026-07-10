import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

function hostnameFromHref(href) {
  try {
    const u = new URL(href);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname;
  } catch {
    return '';
  }
  return '';
}

/** Prefer this registrable domain when fetching a favicon (aliases). */
const FAVICON_HOST_ALIAS = {
  'my.found.com': 'found.com',
  'investor.vanguard.com': 'vanguard.com',
  'go.xero.com': 'xero.com',
  'healthy.kaiserpermanente.org': 'kaiserpermanente.org',
  'www.bayareafastrak.org': 'bayareafastrak.org',
  'play.google.com': 'google.com',
  'messages.google.com': 'google.com',
  'mail.google.com': 'google.com',
  'news.google.com': 'google.com',
  'www.google.com': 'google.com',
  'maxetaenergy.sharepoint.com': 'sharepoint.com',
  'rocompliance.maxetaenergy.com': 'maxetaenergy.com',
};

/** Local brand tiles (company logos). */
const HOST_TILE = {
  'keep.google.com': '/assets/tile-google-keep.png',
  'calendar.google.com': '/assets/tile-google-calendar.png',
  'drive.google.com': '/assets/tile-google-drive.svg',
  'docs.google.com': '/assets/tile-google-drive.svg',
  'teams.microsoft.com': '/assets/tile-microsoft-teams.png',
  'outlook.office.com': '/assets/tile-microsoft-outlook.svg',
  'sharepoint.com': '/assets/tile-sharepoint.png',
  'maxetaenergy.com': '/assets/tile-maxeta.png',
  'rocompliance.maxetaenergy.com': '/assets/tile-maxeta.png',
  'found.com': '/assets/tile-found.png',
  'fetlife.com': '/assets/tile-fetlife.png',
  'web.whatsapp.com': '/assets/tile-whatsapp.svg',
  'whatsapp.com': '/assets/tile-whatsapp.svg',
  'facebook.com': '/assets/tile-facebook.svg',
  'chat.co': '/assets/tile-maxeta.png',
  'energia.pr.gov': '/assets/tile-preb.png',
};

/** Files were once mis-suffixed `.png` but are WebP; fix old bookmark `icon` paths. */
function normalizeTileIconPath(p) {
  const s = String(p).trim();
  if (s === '/assets/tile-google-messages.png') return '/assets/tile-google-messages.webp';
  if (s === '/assets/tile-cursor.png') return '/assets/tile-cursor.webp';
  if (/tile-gemini|tile-perplexity/i.test(s)) return '';
  return s;
}

function explicitBookmarkIcon(row) {
  if (!row.icon || typeof row.icon !== 'string') return null;
  const s = normalizeTileIconPath(row.icon.trim());
  if (!s) return null;
  if (/tile-android-messages/i.test(s)) return '/assets/tile-google-messages.webp';
  return s;
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

function faviconHostForHref(href) {
  const raw = hostnameFromHref(href).toLowerCase();
  if (!raw) return '';
  const bare = raw.replace(/^www\./, '');
  return FAVICON_HOST_ALIAS[raw] || FAVICON_HOST_ALIAS[bare] || bare;
}

function googleFaviconUrl(domain) {
  if (!domain) return '';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

function duckDuckGoIconUrl(domain) {
  if (!domain) return '';
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

function tileForHost(host) {
  if (!host) return '';
  const h = host.toLowerCase().replace(/^www\./, '');
  if (HOST_TILE[h]) return HOST_TILE[h];
  if (HOST_TILE[`www.${h}`]) return HOST_TILE[`www.${h}`];
  return '';
}

function iconSrc(row) {
  const word = String(row?.word || '').trim().toLowerCase();
  if (word === 'rate order' || word === 'rateorder') return '/assets/tile-maxeta.png';
  if (word === 'preb') return '/assets/tile-preb.png';

  const explicit = explicitBookmarkIcon(row);
  if (explicit) return explicit;

  const h = String(row.href || '').trim();
  if (/^cursor:/i.test(h)) return '/assets/tile-cursor.webp';
  if (/^command:/i.test(h)) return '/assets/tile-cursor.webp';
  if (/^signal:/i.test(h)) return '/assets/tile-signal.svg';
  if (/^https?:\/\/drive\.google\.com/i.test(h)) return '/assets/tile-google-drive.svg';
  if (/^https?:\/\/docs\.google\.com\/spreadsheets/i.test(h)) return '/assets/tile-google-drive.svg';
  if (/^https?:\/\/teams\.microsoft\.com/i.test(h)) return '/assets/tile-microsoft-teams.png';
  if (/^https?:\/\/(www\.)?outlook\.office\.com/i.test(h)) return '/assets/tile-microsoft-outlook.svg';
  if (/sharepoint\.com/i.test(h)) return '/assets/tile-sharepoint.png';
  if (/^https?:\/\/rocompliance\.maxetaenergy\.com/i.test(h)) return '/assets/tile-maxeta.png';
  if (/^https?:\/\/(www\.)?calendar\.google\.com/i.test(h)) return '/assets/tile-google-calendar.png';
  if (/^https?:\/\/(www\.)?keep\.google\.com/i.test(h)) return '/assets/tile-google-keep.png';
  if (isGoogleMessagesHttpUrl(h)) return '/assets/tile-google-messages.webp';
  if (/^https?:\/\/(www\.)?fetlife\.com/i.test(h)) return '/assets/tile-fetlife.png';
  if (/^https?:\/\/(web\.)?whatsapp\.com/i.test(h)) return '/assets/tile-whatsapp.svg';
  if (/^https?:\/\/(www\.)?facebook\.com/i.test(h)) return '/assets/tile-facebook.svg';
  if (/^https?:\/\/my\.found\.com/i.test(h)) return '/assets/tile-found.png';
  if (/^https?:\/\/(www\.)?chat\.co\/?/i.test(h)) return '/assets/tile-maxeta.png';
  if (/^https?:\/\/(www\.)?energia\.pr\.gov(\/|$)/i.test(h)) return '/assets/tile-preb.png';

  const host = faviconHostForHref(h);
  const local = tileForHost(host) || tileForHost(hostnameFromHref(h));
  if (local) return local;
  return googleFaviconUrl(host);
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
    icon.referrerPolicy = 'no-referrer';
    icon.src = src;
    icon.addEventListener('error', () => {
      if (icon.dataset.fallback === 'ddg') {
        icon.replaceWith(fallbackGlyph(row.word));
        return;
      }
      const host = faviconHostForHref(row.href);
      const ddg = duckDuckGoIconUrl(host);
      if (ddg && icon.src !== ddg) {
        icon.dataset.fallback = 'ddg';
        icon.src = ddg;
        return;
      }
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

const BOOKMARK_CACHE_PREFIX = 'bookmarks:';
const BOOKMARK_CACHE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** @param {string} dataPath */
function readBookmarkCache(dataPath) {
  return readPanelCache(BOOKMARK_CACHE_PREFIX + dataPath, BOOKMARK_CACHE_MAX_MS);
}

/** @param {string} dataPath @param {unknown} payload */
function writeBookmarkCache(dataPath, payload) {
  writePanelCache(BOOKMARK_CACHE_PREFIX + dataPath, payload);
}

function showBookmarkSkeleton(root, count = 6) {
  root.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'bookmark-section-grid bookmark-section-grid--skeleton';
  grid.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i += 1) {
    const tile = document.createElement('div');
    tile.className = 'bookmark-tile bookmark-tile--skeleton';
    grid.appendChild(tile);
  }
  root.appendChild(grid);
}

function mountSections(root, data, emptyHint) {
  root.replaceChildren();
  if (!data.sections || !Array.isArray(data.sections)) {
    root.innerHTML = `<p class="muted">${emptyHint}</p>`;
    return;
  }
  let any = false;
  let visibleSectionIndex = 0;
  for (const sec of data.sections) {
    if (!sec || typeof sec.title !== 'string' || !Array.isArray(sec.items)) continue;
    let items = sec.items.filter((row) => row && typeof row.href === 'string' && row.word != null);
    const isClientsSection = /client/i.test(sec.title);
    const hasChatCo = items.some((row) => /https?:\/\/(www\.)?chat\.co\/?/i.test(String(row.href || '')));
    if (isClientsSection && !hasChatCo) {
      items = items.concat([
        {
          word: 'chat.co',
          href: 'https://www.chat.co/',
          title: 'chat.co',
          icon: '/assets/tile-chatco.ico',
        },
      ]);
    }
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
function mountBookmarkPayload(root, data, emptyHint) {
  if (data && Array.isArray(data.sections)) {
    mountSections(root, data, emptyHint);
    return true;
  }

  /* Legacy: flat array of { word, href } */
  if (Array.isArray(data) && data.length > 0) {
    root.replaceChildren();
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
    return true;
  }

  return false;
}

export async function mountBookmarkGrid(root, dataPath, emptyHint) {
  if (!root) return;
  root.dataset.bookmarkPath = dataPath;

  const cached = readBookmarkCache(dataPath);
  if (cached) {
    mountBookmarkPayload(root, cached, emptyHint);
  } else {
    showBookmarkSkeleton(root);
  }

  try {
    const r = await fetch(dataPath, { cache: 'no-store' });
    if (!r.ok) {
      if (!cached) root.innerHTML = `<p class="muted">${emptyHint}</p>`;
      return;
    }
    let data;
    try {
      data = await r.json();
    } catch {
      if (!cached) root.innerHTML = '<p class="muted">Invalid JSON in bookmark file.</p>';
      return;
    }

    writeBookmarkCache(dataPath, data);
    if (!mountBookmarkPayload(root, data, emptyHint) && !cached) {
      root.innerHTML = `<p class="muted">${emptyHint}</p>`;
    }
  } catch {
    if (!cached) root.innerHTML = `<p class="muted">${emptyHint}</p>`;
  }
}
