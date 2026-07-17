/**
 * Caddy forward_auth + Express fallback for cloud trusted-device cookie gate.
 * Only Jay's allowlisted device IDs (home Linux laptop + phone) get passwordless access.
 */
import { Router } from 'express';
import {
  buildDeviceIdSetCookie,
  buildTrustedDeviceSetCookie,
  isAllowlistedDeviceId,
  isTrustedDeviceAuthEnabled,
  isTrustedDeviceAuthExemptPath,
  parseDeviceIdFromCookie,
  trustedDeviceAuthRealm,
  verifyBasicAuthCredentials,
  verifyTrustedDeviceCookie,
} from '../lib/trusted-device-auth.js';

const router = Router();

function sendUnauthorized(res) {
  res.setHeader('WWW-Authenticate', `Basic realm="${trustedDeviceAuthRealm()}", charset="UTF-8"`);
  res.status(401).send('Unauthorized');
}

function appendTrustCookies(res, deviceId) {
  res.append('Set-Cookie', buildDeviceIdSetCookie(deviceId));
  res.append('Set-Cookie', buildTrustedDeviceSetCookie(deviceId));
}

/** One-time bookmark: binds an allowlisted device ID and skips future password prompts. */
export function deviceBindHandler(req, res) {
  if (!isTrustedDeviceAuthEnabled()) {
    res.redirect(302, '/');
    return;
  }
  const did = String(req.query.did || parseDeviceIdFromCookie(req.headers.cookie) || '').trim().toLowerCase();
  if (!isAllowlistedDeviceId(did)) {
    res.status(403).type('text/plain').send('Device ID not allowlisted. Set DASHBOARD_TRUSTED_DEVICE_IDS on the server.');
    return;
  }
  appendTrustCookies(res, did);
  res.type('html').send(renderDeviceBindPage(did));
}

function renderDeviceBindPage(deviceId) {
  const devUrl = 'http://127.0.0.1:8788/';
  const prodUrl = 'https://dashbird.duckdns.org/';
  const safeId = String(deviceId || '').replace(/[<>&"]/g, '');
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>dashbird — device trusted</title>
    <link rel="stylesheet" href="/styles.css?v=dev-link-1" />
  </head>
  <body class="dashy dashy--device-bind">
    <header class="topbar glass" role="banner">
      <div class="topbar__head">
        <span class="brand">dashbird</span>
      </div>
      <div class="topbar__end">
        <div class="topbar__env-links" aria-label="Dashboard environments">
          <div class="topbar__env-link">
            <span class="topbar__env-link-label">production link</span>
            <a class="topbar__env-link-url" href="${prodUrl}" rel="noopener noreferrer">dashbird.duckdns.org</a>
          </div>
          <div class="topbar__env-link">
            <span class="topbar__env-link-label">developer link</span>
            <a class="topbar__env-link-url" href="${devUrl}" rel="noopener noreferrer">127.0.0.1:8788</a>
          </div>
        </div>
      </div>
    </header>
    <main class="device-bind-page">
      <p class="device-bind-page__title">This device is trusted</p>
      <p class="device-bind-page__hint">ID <code>${safeId}</code> — no password on later visits.</p>
      <p><a class="device-bind-page__continue" href="/">Open dashboard</a></p>
    </main>
    <script>
      try { localStorage.setItem('dashbird_did', ${JSON.stringify(deviceId)}); } catch (e) {}
    </script>
  </body>
</html>`;
}

/** Caddy forward_auth subrequest — 2xx allows the original request through. */
router.all('/auth', async (req, res) => {
  if (!isTrustedDeviceAuthEnabled()) {
    res.status(200).end();
    return;
  }
  if (verifyTrustedDeviceCookie(req.headers.cookie)) {
    res.status(200).end();
    return;
  }
  const deviceId = parseDeviceIdFromCookie(req.headers.cookie);
  if (isAllowlistedDeviceId(deviceId)) {
    appendTrustCookies(res, deviceId);
    res.status(200).end();
    return;
  }
  const authHeader = req.headers.authorization || req.headers['x-forwarded-authorization'];
  if (await verifyBasicAuthCredentials(authHeader)) {
    if (isAllowlistedDeviceId(deviceId)) {
      appendTrustCookies(res, deviceId);
    }
    res.status(200).end();
    return;
  }
  sendUnauthorized(res);
});

export function trustedDeviceGateMiddleware() {
  return async (req, res, next) => {
    if (!isTrustedDeviceAuthEnabled()) {
      next();
      return;
    }
    if (isTrustedDeviceAuthExemptPath(req.path)) {
      next();
      return;
    }
    if (verifyTrustedDeviceCookie(req.headers.cookie)) {
      next();
      return;
    }
    const deviceId = parseDeviceIdFromCookie(req.headers.cookie);
    if (isAllowlistedDeviceId(deviceId)) {
      appendTrustCookies(res, deviceId);
      next();
      return;
    }
    const authHeader = req.headers.authorization || req.headers['x-forwarded-authorization'];
    if (await verifyBasicAuthCredentials(authHeader)) {
      if (isAllowlistedDeviceId(deviceId)) {
        appendTrustCookies(res, deviceId);
      }
      next();
      return;
    }
    sendUnauthorized(res);
  };
}

export default router;
