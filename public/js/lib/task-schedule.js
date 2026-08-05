/**
 * Schedule task → Google Calendar create-event helper.
 */
import { patchTaskRandomMeta } from './task-location-meta.js';

/** @type {string | null | undefined} */
let cachedAuthuser;
/** @type {Set<string>} */
const overduePriorityInFlight = new Set();

/**
 * Next round hour local → +1 hour slot.
 * @returns {{ start: Date, end: Date }}
 */
export function nextScheduleSlot(now = new Date()) {
  const start = new Date(now.getTime());
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

/**
 * @param {Date} d
 */
function gcalDateStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * @param {string} title
 * @param {{ start?: Date, end?: Date, authuser?: string }} [opts]
 */
export function googleCalendarTaskUrl(title, opts = {}) {
  const params = new URLSearchParams();
  params.set('action', 'TEMPLATE');
  params.set('text', String(title || 'Task').trim().slice(0, 500) || 'Task');
  if (opts.start instanceof Date && opts.end instanceof Date) {
    params.set('dates', `${gcalDateStamp(opts.start)}/${gcalDateStamp(opts.end)}`);
  }
  const authuser = String(opts.authuser || '').trim();
  if (authuser) params.set('authuser', authuser);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @param {number} [nowMs]
 */
export function isScheduleOverdue(meta, nowMs = Date.now()) {
  const raw = meta?.scheduledFor;
  if (typeof raw !== 'string' || !raw) return false;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && nowMs >= ms;
}

/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @param {number} [nowMs]
 */
export function hasSchedule(meta) {
  return typeof meta?.scheduledFor === 'string' && Boolean(meta.scheduledFor);
}

/**
 * @param {Record<string, unknown> | null | undefined} meta
 */
export function scheduleButtonLabel(meta) {
  if (!hasSchedule(meta)) return 'Schedule task';
  return 'Reschedule';
}

/**
 * Compact Schedule/Reschedule button + optional red Overdue label outside the button.
 * @param {{
 *   buttonClass?: string,
 *   wrapClass?: string,
 *   overdueClass?: string,
 * }} [opts]
 * @returns {{
 *   wrap: HTMLElement,
 *   button: HTMLButtonElement,
 *   overdue: HTMLElement,
 *   sync: (meta: Record<string, unknown> | null | undefined) => void,
 * }}
 */
export function createScheduleControl(opts = {}) {
  const wrap = document.createElement('span');
  wrap.className = opts.wrapClass || 'task-schedule';
  const overdue = document.createElement('span');
  overdue.className = opts.overdueClass || 'task-schedule__overdue';
  overdue.textContent = 'Overdue';
  overdue.hidden = true;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = opts.buttonClass || 'task-schedule__btn';
  button.title = 'Add to Google Calendar';
  button.textContent = 'Schedule task';
  wrap.append(overdue, button);
  /**
   * @param {Record<string, unknown> | null | undefined} meta
   */
  function sync(meta) {
    button.textContent = scheduleButtonLabel(meta);
    overdue.hidden = !isScheduleOverdue(meta);
  }
  return { wrap, button, overdue, sync };
}

/**
 * @returns {Promise<string>}
 */
export async function resolveCalendarAuthuser() {
  if (cachedAuthuser !== undefined) return cachedAuthuser || '';
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (!r.ok) {
      cachedAuthuser = '';
      return '';
    }
    const j = await r.json();
    cachedAuthuser = String(j.googleCalendarAuthuser || '').trim();
    return cachedAuthuser;
  } catch {
    cachedAuthuser = '';
    return '';
  }
}

/**
 * Open GCal for the task and persist schedule meta.
 * @param {string} taskId
 * @param {string} title
 * @param {Record<string, unknown> | null | undefined} [currentMeta]
 * @returns {Promise<{ meta: object, row: Record<string, unknown> | null, slot: { start: Date, end: Date } }>}
 */
export async function scheduleTaskToCalendar(taskId, title, currentMeta = null) {
  const slot = nextScheduleSlot();
  const authuser = await resolveCalendarAuthuser();
  const url = googleCalendarTaskUrl(title, { start: slot.start, end: slot.end, authuser });
  window.open(url, '_blank', 'noopener,noreferrer');

  /** @type {Record<string, unknown>} */
  const patch = {
    scheduledAt: new Date().toISOString(),
    scheduledFor: slot.start.toISOString(),
  };
  if (isScheduleOverdue({ scheduledFor: patch.scheduledFor })) {
    patch.priority = 'high';
  }
  const fullMeta = await patchTaskRandomMeta(taskId, patch);
  const row = fullMeta.byTaskId?.[String(taskId)] || {
    ...(currentMeta || {}),
    ...patch,
  };
  return { meta: fullMeta, row, slot };
}

/**
 * If scheduled time has passed and priority is not high, bump to high once.
 * @param {string} taskId
 * @param {Record<string, unknown> | null | undefined} meta
 * @returns {Promise<{ meta: object, row: Record<string, unknown> | null } | null>}
 */
export async function ensureOverduePriority(taskId, meta) {
  const id = String(taskId || '');
  if (!id || !isScheduleOverdue(meta)) return null;
  if (meta?.priority === 'high') return null;
  if (overduePriorityInFlight.has(id)) return null;
  overduePriorityInFlight.add(id);
  try {
    const fullMeta = await patchTaskRandomMeta(id, { priority: 'high' });
    const row = fullMeta.byTaskId?.[id] || { ...(meta || {}), priority: 'high' };
    return { meta: fullMeta, row };
  } catch {
    return null;
  } finally {
    overduePriorityInFlight.delete(id);
  }
}

/**
 * @param {string} taskId
 */
export async function clearTaskSchedule(taskId) {
  const id = String(taskId || '').trim();
  if (!id) return null;
  try {
    return await patchTaskRandomMeta(id, { clearSchedule: true });
  } catch {
    return null;
  }
}
