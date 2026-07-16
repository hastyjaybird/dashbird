/**
 * Browser copy of birthday formatting (server parses in src/lib/network-birthday.js).
 */

const MONTH_LABELS = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * @param {{ birthdayMonth?: number | null, birthdayDay?: number | null, birthdayYear?: number | null }} contact
 */
export function formatContactBirthday(contact) {
  const month = Number(contact?.birthdayMonth);
  if (!month || month < 1 || month > 12) return '';
  const label = MONTH_LABELS[month];
  const day = Number(contact?.birthdayDay);
  const year = Number(contact?.birthdayYear);
  if (!day || day < 1 || day > 31) return label;
  if (!year || year < 1900) return `${label} ${day}`;
  return `${label} ${day}, ${year}`;
}
