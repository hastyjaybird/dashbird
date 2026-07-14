/**
 * Network list prefetch + background page/image warm.
 * Starts as soon as the Network tab is clicked (parallel with UI chunk load).
 */

/** @type {Promise<{ contacts: object[], organizations: object[], groups: object[], preferredContactMethods: string[], relationshipStatuses: string[] }> | null} */
let listPrefetch = null;

/** @type {Promise<object[]> | null} */
let groupsPrefetch = null;

/** @type {number} */
let warmGeneration = 0;

/**
 * @param {Response} r
 */
async function readJson(r) {
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json();
}

/**
 * Shared groups fetch used by Network list preload and the Groups tab.
 * @returns {Promise<object[]>}
 */
function startGroupsPrefetch() {
  if (!groupsPrefetch) {
    groupsPrefetch = (async () => {
      const r = await fetch('/api/network/groups');
      const j = await readJson(r);
      if (!j.ok) throw new Error(j.error || 'groups_failed');
      return Array.isArray(j.groups) ? j.groups : [];
    })().catch((err) => {
      groupsPrefetch = null;
      throw err;
    });
  }
  return groupsPrefetch;
}

/**
 * Kick off contacts + companies (+ groups) list fetch (idempotent while in flight).
 * @returns {Promise<{ contacts: object[], organizations: object[], groups: object[], preferredContactMethods: string[], relationshipStatuses: string[] }>}
 */
export function beginNetworkPrefetch() {
  if (!listPrefetch) {
    const groupsP = startGroupsPrefetch();
    listPrefetch = (async () => {
      const [cr, or, groups] = await Promise.all([
        fetch('/api/network/contacts'),
        fetch('/api/network/organizations'),
        groupsP.catch(() => []),
      ]);
      const j = await readJson(cr);
      const oj = await readJson(or);
      if (!j.ok) throw new Error(j.error || 'contacts_failed');
      return {
        contacts: Array.isArray(j.contacts) ? j.contacts : [],
        organizations: oj.ok && Array.isArray(oj.organizations) ? oj.organizations : [],
        groups: Array.isArray(groups) ? groups : [],
        preferredContactMethods: Array.isArray(j.preferredContactMethods)
          ? j.preferredContactMethods
          : [],
        relationshipStatuses: Array.isArray(j.relationshipStatuses) ? j.relationshipStatuses : [],
      };
    })().catch((err) => {
      listPrefetch = null;
      throw err;
    });
  }
  return listPrefetch;
}

/**
 * Consume the in-flight/completed prefetch (clears so a later reload fetches fresh).
 * Groups stay available via {@link takeGroupsPrefetch} until that is consumed or invalidated.
 * @returns {Promise<{ contacts: object[], organizations: object[], groups: object[], preferredContactMethods: string[], relationshipStatuses: string[] }>}
 */
export function takeNetworkPrefetch() {
  const p = beginNetworkPrefetch();
  listPrefetch = null;
  return p;
}

/**
 * Prefetch / reuse groups list (idempotent while in flight).
 * @returns {Promise<object[]>}
 */
export function beginGroupsPrefetch() {
  beginNetworkPrefetch();
  return startGroupsPrefetch();
}

/**
 * Take the prefetched groups list (clears cache so next begin fetches fresh).
 * @returns {Promise<object[]>}
 */
export function takeGroupsPrefetch() {
  const p = beginGroupsPrefetch();
  groupsPrefetch = null;
  return p;
}

/**
 * Force a fresh list fetch on next begin/take (e.g. after mutations).
 */
export function invalidateNetworkPrefetch() {
  listPrefetch = null;
  groupsPrefetch = null;
}

/**
 * @param {string | null | undefined} url
 * @param {string | null | undefined} updatedAt
 */
function mediaUrl(url, updatedAt) {
  const u = String(url || '').trim();
  if (!u) return '';
  const t = encodeURIComponent(updatedAt || '');
  return `${u}${u.includes('?') ? '&' : '?'}t=${t}`;
}

/**
 * @param {string} url
 * @returns {Promise<void>}
 */
function preloadImage(url) {
  return new Promise((resolve) => {
    if (!url) {
      resolve();
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 */
async function mapPool(items, limit, fn) {
  if (!items.length) return;
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          await fn(items[idx]);
        } catch {
          /* ignore warm failures */
        }
      }
    }),
  );
}

/**
 * @param {() => void} cb
 */
function whenIdle(cb) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => cb(), { timeout: 2500 });
  } else {
    setTimeout(cb, 50);
  }
}

/**
 * Soft-fetch one entity so SQLite + JSON path are warm (responses are no-store).
 * @param {string} url
 */
async function warmJson(url) {
  try {
    await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    /* ignore */
  }
}

/**
 * After lists land, warm avatars/logos in the background.
 * Detail GETs are skipped — the list payload already includes full contact/org rows,
 * and hammering hundreds of detail URLs makes the Network UI feel frozen.
 * @param {object[]} contacts
 * @param {object[]} organizations
 * @param {{ details?: boolean }} [opts]
 */
export function warmNetworkPages(contacts, organizations, opts = {}) {
  const gen = ++warmGeneration;
  const people = Array.isArray(contacts) ? contacts : [];
  const companies = Array.isArray(organizations) ? organizations : [];
  const warmDetails = opts.details === true;

  whenIdle(() => {
    if (gen !== warmGeneration) return;

    const images = [
      ...people.map((c) => mediaUrl(c.avatarUrl, c.updatedAt)).filter(Boolean),
      ...companies.map((o) => mediaUrl(o.logoUrl, o.updatedAt)).filter(Boolean),
    ];

    void mapPool(images, 6, preloadImage);

    if (!warmDetails) return;

    const detailUrls = [
      ...people.map((c) => (c?.id ? `/api/network/contacts/${encodeURIComponent(c.id)}` : '')),
      ...companies.map((o) => (o?.id ? `/api/network/organizations/${encodeURIComponent(o.id)}` : '')),
    ].filter(Boolean);

    void mapPool(detailUrls, 2, async (url) => {
      if (gen !== warmGeneration) return;
      await warmJson(url);
    });
  });
}
