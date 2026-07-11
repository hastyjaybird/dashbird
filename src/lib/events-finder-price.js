/**
 * Ticket price parsing for Events finder (display + dedupe).
 * Free / unknown → no display label. Paid → "$25" or "$25–$40".
 */

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function parseMoneyAmount(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^(free|gratis|donation|pay\s*what\s*you\s*(can|want)|pwyc|comp(limentary)?)$/i.test(s)) {
    return 0;
  }
  // "$25", "25.00 USD", "From $15", "$10 - $25", "USD 40"
  const nums = [...s.matchAll(/(?:\$|usd\s*)?\s*(\d+(?:\.\d{1,2})?)/gi)].map((m) => Number(m[1]));
  const finite = nums.filter((n) => Number.isFinite(n) && n >= 0);
  if (!finite.length) return null;
  return Math.min(...finite);
}

/**
 * @param {unknown} raw
 * @returns {{ min: number, max: number } | null}
 */
function parseMoneyRange(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return { min: raw, max: raw };
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^(free|gratis|donation|pay\s*what\s*you\s*(can|want)|pwyc|comp(limentary)?)$/i.test(s)) {
    return { min: 0, max: 0 };
  }
  const nums = [...s.matchAll(/(?:\$|usd\s*)?\s*(\d+(?:\.\d{1,2})?)/gi)].map((m) => Number(m[1]));
  const finite = nums.filter((n) => Number.isFinite(n) && n >= 0);
  if (!finite.length) return null;
  return { min: Math.min(...finite), max: Math.max(...finite) };
}

/**
 * @param {unknown} offers
 * @returns {{ min: number, max: number } | null}
 */
function rangeFromSchemaOffers(offers) {
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];
  /** @type {number[]} */
  const amounts = [];
  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (offer);
    for (const key of ['lowPrice', 'highPrice', 'price']) {
      const n = parseMoneyAmount(o[key]);
      if (n != null) amounts.push(n);
    }
    if (o.priceSpecification && typeof o.priceSpecification === 'object') {
      const ps = /** @type {Record<string, unknown>} */ (o.priceSpecification);
      for (const key of ['price', 'minPrice', 'maxPrice']) {
        const n = parseMoneyAmount(ps[key]);
        if (n != null) amounts.push(n);
      }
    }
  }
  if (!amounts.length) return null;
  return { min: Math.min(...amounts), max: Math.max(...amounts) };
}

/**
 * @param {number} min
 * @param {number} max
 * @returns {string | null}
 */
function formatPriceLabel(min, max) {
  if (!Number.isFinite(min) || min < 0) return null;
  if (min <= 0 && (!Number.isFinite(max) || max <= 0)) return null;
  const fmt = (n) => {
    const rounded = Math.round(n * 100) / 100;
    return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
  };
  if (Number.isFinite(max) && max > min) return `${fmt(min)}–${fmt(max)}`;
  return fmt(min > 0 ? min : max);
}

/**
 * Resolve ticket price from a normalized event (and nested raw/schema).
 * @param {object} event
 * @returns {{
 *   price: number | null,
 *   priceMax: number | null,
 *   priceLabel: string | null,
 *   isFree: boolean,
 * }}
 */
export function resolveEventPrice(event) {
  if (!event || typeof event !== 'object') {
    return { price: null, priceMax: null, priceLabel: null, isFree: false };
  }

  /** @type {{ min: number, max: number } | null} */
  let range = null;

  const direct =
    parseMoneyRange(/** @type {{ price?: unknown }} */ (event).price)
    || parseMoneyRange(/** @type {{ ticketPrice?: unknown }} */ (event).ticketPrice)
    || parseMoneyRange(/** @type {{ minPrice?: unknown }} */ (event).minPrice)
    || parseMoneyRange(/** @type {{ priceMin?: unknown }} */ (event).priceMin);
  if (direct) range = direct;

  const priceMaxField = parseMoneyAmount(
    /** @type {{ priceMax?: unknown, maxPrice?: unknown }} */ (event).priceMax
      ?? /** @type {{ maxPrice?: unknown }} */ (event).maxPrice,
  );
  if (range && priceMaxField != null && priceMaxField > range.max) {
    range = { min: range.min, max: priceMaxField };
  }

  const tickets =
    /** @type {{ ticketsInfo?: unknown }} */ (event).ticketsInfo
    ?? /** @type {{ raw?: { ticketsInfo?: unknown } }} */ (event).raw?.ticketsInfo;
  if (!range && tickets && typeof tickets === 'object') {
    const ti = /** @type {Record<string, unknown>} */ (tickets);
    range = parseMoneyRange(ti.price) || parseMoneyRange(ti.subtitle);
  }

  const schema =
    /** @type {{ raw?: { schema?: Record<string, unknown> } }} */ (event).raw?.schema;
  if (!range && schema && typeof schema === 'object') {
    range = rangeFromSchemaOffers(schema.offers);
  }

  // Explicit free in title/description when no dollar amount found.
  if (!range) {
    const blob = [
      event.title,
      event.description,
      /** @type {{ raw?: { description?: unknown } }} */ (event).raw?.description,
    ]
      .map((p) => String(p || ''))
      .join(' ');
    if (/\bfree\b/i.test(blob) && !/\$\s*\d/.test(blob)) {
      return { price: 0, priceMax: 0, priceLabel: null, isFree: true };
    }
    const fromText = parseMoneyRange(
      blob.match(/\$\s*\d+(?:\.\d{1,2})?(?:\s*[-–—to]+\s*\$?\s*\d+(?:\.\d{1,2})?)?/i)?.[0],
    );
    if (fromText) range = fromText;
  }

  if (!range) {
    return { price: null, priceMax: null, priceLabel: null, isFree: false };
  }

  const isFree = range.min <= 0 && range.max <= 0;
  if (isFree) {
    return { price: 0, priceMax: 0, priceLabel: null, isFree: true };
  }

  const min = range.min > 0 ? range.min : range.max;
  const max = range.max;
  return {
    price: min,
    priceMax: max,
    priceLabel: formatPriceLabel(min, max),
    isFree: false,
  };
}

/**
 * Attach resolved price fields onto an event (non-destructive copy).
 * @param {object} event
 * @returns {object}
 */
export function withEventPrice(event) {
  const resolved = resolveEventPrice(event);
  return {
    ...event,
    price: resolved.price,
    priceMax: resolved.priceMax,
    priceLabel: resolved.priceLabel,
    isFree: resolved.isFree,
  };
}

/**
 * Comparable ticket amount for dedupe (higher wins). Free/unknown → null.
 * Uses the high end of a range when present.
 * @param {object} event
 * @returns {number | null}
 */
export function eventTicketPriceRank(event) {
  const resolved = resolveEventPrice(event);
  if (resolved.isFree) return 0;
  if (resolved.priceMax != null && resolved.priceMax > 0) return resolved.priceMax;
  if (resolved.price != null && resolved.price > 0) return resolved.price;
  return null;
}
