/**
 * Client-side read/unread tracking for Local News.
 *
 * The server has no per-article read flag — thumbs, snooze, and skip all mean
 * "change my feed", which is different from "I already looked at this". Read
 * state is therefore local to the browser and capped so it cannot grow forever.
 */

const KEY = 'dashbird-news-read-v1';
const MAX_IDS = 800;

/** @type {Set<string> | null} */
let cache = null;

function load() {
  if (cache) return cache;
  cache = new Set();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id) cache.add(id);
        }
      }
    }
  } catch {
    /* private mode / corrupt value — start empty */
  }
  return cache;
}

function persist() {
  const ids = [...load()];
  // Newest additions are at the tail, so trim from the front.
  const trimmed = ids.length > MAX_IDS ? ids.slice(ids.length - MAX_IDS) : ids;
  cache = new Set(trimmed);
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* quota */
  }
}

/** @param {string} id */
export function isRead(id) {
  if (!id) return false;
  return load().has(id);
}

/** @param {string} id */
export function markRead(id) {
  if (!id) return;
  const set = load();
  if (set.has(id)) return;
  set.add(id);
  persist();
}

/** @param {string} id */
export function markUnread(id) {
  if (!id) return;
  const set = load();
  if (!set.delete(id)) return;
  persist();
}

/** @param {string} id */
export function toggleRead(id) {
  if (isRead(id)) {
    markUnread(id);
    return false;
  }
  markRead(id);
  return true;
}

/** @param {Iterable<string>} ids */
export function markAllRead(ids) {
  const set = load();
  let changed = false;
  for (const id of ids) {
    if (id && !set.has(id)) {
      set.add(id);
      changed = true;
    }
  }
  if (changed) persist();
}

/**
 * @param {Array<{ id?: string }>} articles
 * @returns {number}
 */
export function unreadCount(articles) {
  const set = load();
  let n = 0;
  for (const a of articles || []) {
    if (a?.id && !set.has(a.id)) n += 1;
  }
  return n;
}
