#!/usr/bin/env node
/**
 * Smoke test for the cloud trusted-device gate (src/routes/trusted-device-auth.js).
 *
 * Guards the rule that only two devices skip the password, and that they only skip it
 * after one password challenge at /auth/device-bind: a bare dashbird_did cookie must
 * never be enough, because the allowlisted UUIDs are published in this repo.
 *
 * Usage:
 *   npm run smoke:trusted-device-auth
 */
import express from 'express';
import bcrypt from 'bcryptjs';

const ALLOWED_ID = 'edd37155-3ffe-4d18-a775-d6cdcedbf343';
const OTHER_ID = '00000000-1111-2222-3333-444444444444';
const PASSWORD = 'smoke-test-password';

process.env.DASHBOARD_TRUSTED_DEVICE_SECRET = 'smoke-secret-not-a-real-key';
process.env.DASHBOARD_BASIC_AUTH_USER = 'dashbird';
process.env.DASHBOARD_BASIC_AUTH_HASH = bcrypt.hashSync(PASSWORD, 10);
process.env.DASHBOARD_TRUSTED_DEVICE_IDS = `${ALLOWED_ID},1c0c1947-ad36-4032-aed5-00eb5b28e166`;

const { default: trustedDeviceAuthRouter, deviceBindHandler, trustedDeviceGateMiddleware } = await import(
  '../src/routes/trusted-device-auth.js'
);

const app = express();
app.get('/auth/device-bind', deviceBindHandler);
app.use(trustedDeviceGateMiddleware());
app.use('/api/trusted-device', trustedDeviceAuthRouter);
app.get('/api/ping', (_req, res) => res.json({ ok: true }));

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const basic = `Basic ${Buffer.from(`dashbird:${PASSWORD}`, 'utf8').toString('base64')}`;

let failures = 0;

/**
 * @param {string} name
 * @param {boolean} pass
 * @param {string} [detail]
 */
function check(name, pass, detail = '') {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * @param {string} path
 * @param {Record<string, string>} [headers]
 */
function get(path, headers = {}) {
  return fetch(`${base}${path}`, { headers, redirect: 'manual' });
}

/** @param {Response} res */
function trustedCookieFrom(res) {
  const raw = res.headers.getSetCookie?.() || [];
  const hit = raw.find((c) => c.startsWith('dashbird_trusted='));
  return hit ? hit.split(';')[0].slice('dashbird_trusted='.length) : '';
}

console.log('[smoke] trusted-device gate');

const anon = await get('/api/ping');
check('no credentials → 401', anon.status === 401, `got ${anon.status}`);

const bareDid = await get('/api/ping', { Cookie: `dashbird_did=${ALLOWED_ID}` });
check('bare allowlisted device-id cookie → 401', bareDid.status === 401, `got ${bareDid.status}`);

const bareDidForwardAuth = await get('/api/trusted-device/auth', { Cookie: `dashbird_did=${ALLOWED_ID}` });
check('bare device-id at forward_auth → 401', bareDidForwardAuth.status === 401, `got ${bareDidForwardAuth.status}`);

const bindNoPassword = await get(`/auth/device-bind?did=${ALLOWED_ID}`);
check('device-bind without password → 401', bindNoPassword.status === 401, `got ${bindNoPassword.status}`);

const bindWrongPassword = await get(`/auth/device-bind?did=${ALLOWED_ID}`, {
  Authorization: `Basic ${Buffer.from('dashbird:wrong', 'utf8').toString('base64')}`,
});
check('device-bind with wrong password → 401', bindWrongPassword.status === 401, `got ${bindWrongPassword.status}`);

const bindOther = await get(`/auth/device-bind?did=${OTHER_ID}`, { Authorization: basic });
check('device-bind with password but unlisted id → 403', bindOther.status === 403, `got ${bindOther.status}`);

const bound = await get(`/auth/device-bind?did=${ALLOWED_ID}`, { Authorization: basic });
const signed = trustedCookieFrom(bound);
check('device-bind with password → 200 + signed cookie', bound.status === 200 && Boolean(signed), `got ${bound.status}`);

const withSigned = await get('/api/ping', { Cookie: `dashbird_trusted=${signed}` });
check('signed cookie → 200 (passwordless afterwards)', withSigned.status === 200, `got ${withSigned.status}`);

const tampered = await get('/api/ping', { Cookie: `dashbird_trusted=${signed.slice(0, -2)}xy` });
check('tampered signature → 401', tampered.status === 401, `got ${tampered.status}`);

const swappedId = signed.replace(ALLOWED_ID, OTHER_ID);
const swapped = await get('/api/ping', { Cookie: `dashbird_trusted=${swappedId}` });
check('device id swapped in signed cookie → 401', swapped.status === 401, `got ${swapped.status}`);

const passwordOnly = await get('/api/ping', { Authorization: basic });
check('basic auth alone → 200', passwordOnly.status === 200, `got ${passwordOnly.status}`);

const passwordWithDid = await get('/api/ping', { Authorization: basic, Cookie: `dashbird_did=${ALLOWED_ID}` });
check(
  'basic auth + allowlisted did → 200 and mints signed cookie',
  passwordWithDid.status === 200 && Boolean(trustedCookieFrom(passwordWithDid)),
  `got ${passwordWithDid.status}`,
);

// LAN compose sets no secret/user/hash — the gate must stay fully open there.
delete process.env.DASHBOARD_TRUSTED_DEVICE_SECRET;
const lan = await get('/api/ping');
check('LAN mode (no secret configured) → open', lan.status === 200, `got ${lan.status}`);

server.close();

if (failures) {
  console.error(`[smoke] ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('[smoke] trusted-device gate: all checks passed');
}
