/**
 * Offline validation for Daily Summary "Open in Gmail" deep links.
 * Run: node scripts/validate-gmail-open-url.mjs
 */
import assert from 'node:assert/strict';
import {
  gmailAndroidAppUrl,
  gmailDirectWebMessageUrl,
  gmailMobileOpenUrl,
  gmailNativeAppUrl,
  gmailTargetHash,
  gmailWebMessageUrl,
  sanitizeGmailOpenSource,
} from '../public/js/lib/gmail-open-url.js';
import { gmailReplyUrl } from '../src/lib/gmail-weekly-summary-store.js';

const src = {
  email: 'julia.hasty@gmail.com',
  threadId: '19f96aac68af44e9',
  gmailId: '19f96aac68af44e9', // collapsed IMAP id — must not win over thread
  messageId: '152651',
  rfc822MessageId: '1899563979.8099968@linkedin.com',
  subject: 'Jay, a new email address was added',
  from: 'LinkedIn <security@linkedin.com>',
};

assert.equal(gmailTargetHash(src), 'all/19f96aac68af44e9');

const clean = sanitizeGmailOpenSource(src);
assert.equal(clean?.gmailId, '');
assert.equal(clean?.threadId, '19f96aac68af44e9');
assert.equal(clean?.messageId, ''); // decimal UID stripped

// Desktop: AccountChooser → authuser + #all/threadId
const web = gmailWebMessageUrl(src);
assert.match(web, /^https:\/\/accounts\.google\.com\/AccountChooser\?/);
const continueUrl = decodeURIComponent(new URL(web).searchParams.get('continue') || '');
assert.equal(
  continueUrl,
  'https://mail.google.com/mail/u/?authuser=julia.hasty@gmail.com#all/19f96aac68af44e9',
);
assert.ok(web.includes('#all%2F19f96aac68af44e9') || continueUrl.endsWith('#all/19f96aac68af44e9'));
assert.equal(gmailReplyUrl(src), web);

// Android: intent into Gmail app with /u/{email}/#all/{threadId}
const direct = gmailDirectWebMessageUrl(src);
assert.equal(direct, 'https://mail.google.com/mail/u/julia.hasty@gmail.com/#all/19f96aac68af44e9');
const intent = gmailAndroidAppUrl(src, web);
assert.match(intent, /^intent:\/\/mail\.google\.com\/mail\/u\/julia\.hasty@gmail\.com\/%23all\/19f96aac68af44e9#Intent;/);
assert.match(intent, /package=com\.google\.android\.gm;/);
assert.ok(intent.includes(`S.browser_fallback_url=${encodeURIComponent(web)}`));
assert.equal(
  gmailMobileOpenUrl(web, src, 'Mozilla/5.0 (Linux; Android 14)'),
  intent,
);

// iOS: conversation-by-thread
assert.equal(gmailNativeAppUrl(src), 'googlegmail:///cv?th=19f96aac68af44e9');
assert.equal(
  gmailMobileOpenUrl(web, src, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'),
  'googlegmail:///cv?th=19f96aac68af44e9',
);

// No threadId → rfc822 search
const noThread = {
  email: 'jay.intake.box@gmail.com',
  threadId: '152651', // decimal — sanitized away
  messageId: '152651',
  rfc822MessageId: '<abc@mail.example>',
  subject: 'Hello',
};
assert.equal(gmailTargetHash(sanitizeGmailOpenSource(noThread)), 'search/rfc822msgid%3Aabc%40mail.example');
const webRfc = gmailWebMessageUrl(noThread);
const contRfc = decodeURIComponent(new URL(webRfc).searchParams.get('continue') || '');
assert.ok(contRfc.includes('#search/rfc822msgid:abc@mail.example'));
assert.equal(
  gmailDirectWebMessageUrl(noThread),
  'https://mail.google.com/mail/u/jay.intake.box@gmail.com/#search/rfc822msgid%3Aabc%40mail.example',
);

// Distinct gmailId when no thread
const msgOnly = {
  email: 'a@x.com',
  threadId: '',
  gmailId: '19f9fef544d420cc',
  rfc822MessageId: '',
};
assert.equal(gmailTargetHash(msgOnly), 'all/19f9fef544d420cc');

console.log('validate-gmail-open-url: ok');
