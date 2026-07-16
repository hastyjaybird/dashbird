/**
 * Offline validation for Daily Summary expiry / pin / chronological order.
 * Run: node scripts/validate-daily-summary.mjs
 */
import assert from 'node:assert/strict';
import {
  GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS,
  GMAIL_DAILY_SUMMARY_UNPIN_GRACE_MS,
  collapseDuplicateDailySummaryItems,
  dailySummaryItemsAreSameAsk,
  keepNewestSourceOnly,
  pruneExpiredGmailDailySummary,
  openGmailWeeklyItems,
  scrubEventMentionsFromSummary,
  sortItemsChronological,
  isPastDailySummaryRetention,
} from '../src/lib/gmail-weekly-summary-store.js';

assert.equal(GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS, 10);
assert.equal(GMAIL_DAILY_SUMMARY_UNPIN_GRACE_MS, 30_000);

const now = Date.parse('2026-07-14T12:00:00.000Z');
const old = new Date(now - 11 * 24 * 60 * 60 * 1000).toISOString();
const fresh = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
const mid = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();

function baseItem(partial) {
  return {
    detail: '',
    deadline: null,
    deadlineSource: 'none',
    needsReply: false,
    mailboxes: [],
    sources: [],
    pinned: false,
    unpinDeleteAt: null,
    ...partial,
  };
}

const { digest, changed } = pruneExpiredGmailDailySummary(
  {
    summaryText: 'stale prose',
    generatedAt: old,
    lastScanYmd: '2026-07-01',
    windowDays: 10,
    lastError: null,
    items: [
      baseItem({
        id: 'a',
        title: 'Old open',
        status: 'open',
        createdAt: old,
        updatedAt: old,
        fingerprint: 'oldfp',
        sources: [{ email: 'a@x.com', messageId: '1', threadId: '', subject: 'Old', date: old }],
      }),
      baseItem({
        id: 'b',
        title: 'Fresh open',
        status: 'open',
        createdAt: fresh,
        updatedAt: fresh,
        fingerprint: 'freshfp',
        sources: [{ email: 'a@x.com', messageId: '2', threadId: '', subject: 'Fresh', date: fresh }],
      }),
      baseItem({
        id: 'c',
        title: 'Pinned old',
        status: 'open',
        pinned: true,
        createdAt: old,
        updatedAt: old,
        fingerprint: 'pinnedfp',
        sources: [{ email: 'a@x.com', messageId: '3', threadId: '', subject: 'Pinned', date: old }],
      }),
    ],
  },
  now,
);

assert.equal(changed, true);
assert.equal(digest.summaryText, '');
assert.equal(digest.generatedAt, null);
// Old unpinned hard-deleted (not dismissed).
assert.equal(digest.items.find((i) => i.id === 'a'), undefined);
assert.equal(digest.items.find((i) => i.id === 'b')?.status, 'open');
assert.equal(digest.items.find((i) => i.id === 'c')?.status, 'open');
assert.equal(digest.items.find((i) => i.id === 'c')?.pinned, true);
assert.deepEqual(
  openGmailWeeklyItems(digest).map((i) => i.id),
  ['b', 'c'],
);

// Unpin grace: still visible before deleteAt, gone after.
const graceUntil = new Date(now + 15_000).toISOString();
const { digest: graceDigest } = pruneExpiredGmailDailySummary(
  {
    summaryText: '',
    generatedAt: fresh,
    lastScanYmd: '2026-07-14',
    windowDays: 10,
    lastError: null,
    items: [
      baseItem({
        id: 'd',
        title: 'Unpinned expired',
        status: 'open',
        pinned: false,
        unpinDeleteAt: graceUntil,
        createdAt: old,
        updatedAt: old,
        fingerprint: 'gracefp',
        sources: [{ email: 'a@x.com', messageId: '4', threadId: '', subject: 'Grace', date: old }],
      }),
    ],
  },
  now,
);
assert.equal(graceDigest.items.find((i) => i.id === 'd')?.status, 'open');

const { digest: afterGrace } = pruneExpiredGmailDailySummary(graceDigest, now + 20_000);
assert.equal(afterGrace.items.find((i) => i.id === 'd'), undefined);

// Chronological: newest first; pin does not float.
const sorted = sortItemsChronological([
  baseItem({
    id: 'old',
    title: 'Old',
    status: 'open',
    pinned: true,
    createdAt: old,
    updatedAt: now,
    fingerprint: '1',
    sources: [{ email: 'a@x.com', messageId: '1', threadId: '', subject: 'x', date: old }],
  }),
  baseItem({
    id: 'new',
    title: 'New',
    status: 'open',
    pinned: false,
    createdAt: fresh,
    updatedAt: fresh,
    fingerprint: '2',
    sources: [{ email: 'a@x.com', messageId: '2', threadId: '', subject: 'y', date: fresh }],
  }),
  baseItem({
    id: 'mid',
    title: 'Mid',
    status: 'open',
    pinned: true,
    createdAt: mid,
    updatedAt: mid,
    fingerprint: '3',
    sources: [{ email: 'a@x.com', messageId: '3', threadId: '', subject: 'z', date: mid }],
  }),
]);
assert.deepEqual(
  sorted.map((i) => i.id),
  ['new', 'mid', 'old'],
);

assert.equal(
  isPastDailySummaryRetention(
    baseItem({
      id: 'x',
      title: 'x',
      status: 'open',
      createdAt: old,
      updatedAt: old,
      fingerprint: 'x',
      sources: [{ email: 'a@x.com', messageId: '9', threadId: '', subject: 'x', date: old }],
    }),
    now,
  ),
  true,
);

const scrubbed = scrubEventMentionsFromSummary(
  'Workspace reminders need attention. You also have a few upcoming events, but those are handled by Events Finder. No other urgent actions are required.',
);
assert.equal(scrubbed, 'Workspace reminders need attention.');
assert.equal(
  scrubEventMentionsFromSummary('Only an Events Finder handoff sentence.'),
  '',
);
assert.equal(
  scrubEventMentionsFromSummary('Apify usage exceeded. No other urgent actions are required.'),
  'Apify usage exceeded.',
);

// Newest source only when the same ask repeats across emails.
const newestOnly = keepNewestSourceOnly([
  { email: 'a@x.com', messageId: '1', threadId: '', subject: 'Security alert', date: old },
  { email: 'a@x.com', messageId: '2', threadId: '', subject: 'Security alert', date: fresh },
]);
assert.equal(newestOnly.length, 1);
assert.equal(newestOnly[0].messageId, '2');

assert.equal(
  dailySummaryItemsAreSameAsk(
    baseItem({
      title: 'Review your PayPal statement',
      company: 'PayPal',
      status: 'open',
      sources: [{ email: 'a@x.com', messageId: '1', threadId: '', subject: 'June statement', date: old }],
    }),
    baseItem({
      title: 'Check your PayPal account statement',
      company: 'PayPal',
      status: 'open',
      sources: [{ email: 'a@x.com', messageId: '2', threadId: '', subject: 'June statement', date: fresh }],
    }),
  ),
  true,
);

// Distinct workspace asks must not collapse together.
assert.equal(
  dailySummaryItemsAreSameAsk(
    baseItem({
      title: 'Check workspace deletion reminders',
      company: 'Cursor',
      status: 'open',
      sources: [
        {
          email: 'a@x.com',
          messageId: '1',
          threadId: '',
          subject: 'Reminder: Your workspace "MarioJay" will be deleted',
          date: old,
        },
      ],
    }),
    baseItem({
      title: 'Check workspace deletion reminders',
      company: 'Cursor',
      status: 'open',
      sources: [
        {
          email: 'a@x.com',
          messageId: '2',
          threadId: '',
          subject: 'Reminder: Your workspace "Jaybird\'s Workspace" will be deleted',
          date: fresh,
        },
      ],
    }),
  ),
  false,
);

const collapsed = collapseDuplicateDailySummaryItems([
  baseItem({
    id: 'p1',
    title: 'Update privacy settings for Julia\'s account',
    company: 'Acme',
    status: 'open',
    createdAt: old,
    updatedAt: old,
    fingerprint: 'p1',
    sources: [
      {
        email: 'a@x.com',
        messageId: '1',
        threadId: '',
        subject: 'Action required: Update your privacy settings',
        date: old,
      },
    ],
  }),
  baseItem({
    id: 'p2',
    title: 'Check your privacy settings',
    company: 'Acme',
    status: 'open',
    createdAt: fresh,
    updatedAt: fresh,
    fingerprint: 'p2',
    sources: [
      {
        email: 'a@x.com',
        messageId: '2',
        threadId: '',
        subject: 'Action required: Update your privacy settings',
        date: fresh,
      },
      {
        email: 'a@x.com',
        messageId: '3',
        threadId: '',
        subject: 'Action required: Update your privacy settings',
        date: mid,
      },
    ],
  }),
  baseItem({
    id: 'other',
    title: 'Confirm Vultr server',
    company: 'Vultr',
    status: 'open',
    createdAt: mid,
    updatedAt: mid,
    fingerprint: 'other',
    sources: [
      { email: 'a@x.com', messageId: '9', threadId: '', subject: 'Server activated', date: mid },
    ],
  }),
]);
const collapsedOpen = collapsed.filter((i) => i.status === 'open');
assert.equal(collapsedOpen.length, 2);
assert.equal(collapsedOpen.find((i) => i.company === 'Acme')?.id, 'p2');
assert.equal(collapsedOpen.find((i) => i.company === 'Acme')?.sources.length, 1);
assert.equal(collapsedOpen.find((i) => i.company === 'Acme')?.sources[0].messageId, '2');

console.log('validate-daily-summary: ok');
