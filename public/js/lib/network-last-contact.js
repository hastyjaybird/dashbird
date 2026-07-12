/**
 * Browser copy of last-contact formatting (server parses in src/lib/network-last-contact.js).
 * Display uses UTC calendar parts because the server stores UTC-noon anchors.
 */

/**
 * @param {{ lastContactAt?: string | null, lastContactPrecision?: string | null }} contact
 */
export function formatContactLastContact(contact) {
  if (!contact?.lastContactAt) return '';
  const d = new Date(contact.lastContactAt);
  if (Number.isNaN(d.getTime())) return '';
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const yy = String(d.getUTCFullYear()).slice(-2);
  if (contact.lastContactPrecision === 'month') return `${month}/${yy}`;
  return `${month}/${day}/${yy}`;
}
