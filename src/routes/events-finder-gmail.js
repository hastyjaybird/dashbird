/**
 * Gmail intake OAuth + status for Events sources (multi-account).
 */
import { Router } from 'express';
import {
  buildGmailOAuthAuthUrl,
  exchangeGmailOAuthCode,
  gmailIntakeAddress,
  gmailIntakeAddresses,
  gmailIntakeStatusSummary,
  normalizeGmailAddress,
  probeGmailEventsIntake,
} from '../lib/events-finder-gmail.js';

const router = Router();

/**
 * GET /api/events-finder-gmail/status — whether OAuth is configured / connected.
 */
router.get('/status', async (_req, res) => {
  try {
    const summary = await gmailIntakeStatusSummary();
    const probe = summary.tokenOnDisk || summary.oauthConfigured
      ? await probeGmailEventsIntake()
      : null;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...summary,
      probe: probe
        ? {
            value: probe.value,
            output: probe.output,
            ingestTest: probe.ingestTest,
            ingestOk: probe.ingestOk,
            email: probe.email,
            emails: probe.emails || summary.addresses,
            accounts: probe.accounts || null,
          }
        : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * GET /api/events-finder-gmail/oauth/start?email= — redirect browser to Google consent.
 */
router.get('/oauth/start', (req, res) => {
  try {
    const email = normalizeGmailAddress(req.query.email) || gmailIntakeAddress();
    const url = buildGmailOAuthAuthUrl(process.env, { email });
    res.redirect(302, url);
  } catch (e) {
    const status = e?.code === 'oauth_not_configured' ? 503 : 500;
    const list = gmailIntakeAddresses().join(', ');
    res.status(status).type('html').send(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
        <h1>Gmail OAuth</h1>
        <p>${String(e?.message || e)}</p>
        <p>Set <code>GOOGLE_OAUTH_CLIENT_ID</code> and <code>GOOGLE_OAUTH_CLIENT_SECRET</code> in <code>.env</code>,
        add redirect URI <code>/api/events-finder-gmail/oauth/callback</code> on the Google Cloud OAuth client,
        then restart. Sign in as one of: <strong>${list}</strong>.</p>
        <p><a href="/">Back to dashboard</a></p>
      </body></html>`,
    );
  }
});

/**
 * GET /api/events-finder-gmail/oauth/callback — exchange code, save refresh token.
 */
router.get('/oauth/callback', async (req, res) => {
  const err = String(req.query.error || '').trim();
  if (err) {
    res.status(400).type('html').send(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
        <h1>Gmail connect failed</h1>
        <p>${err}</p>
        <p><a href="/">Back to dashboard</a></p>
      </body></html>`,
    );
    return;
  }
  const code = String(req.query.code || '').trim();
  if (!code) {
    res.status(400).type('html').send(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
        <h1>Missing authorization code</h1>
        <p><a href="/api/events-finder-gmail/oauth/start">Try again</a></p>
      </body></html>`,
    );
    return;
  }
  try {
    const intendedEmail = normalizeGmailAddress(req.query.state);
    const token = await exchangeGmailOAuthCode(code, process.env, { intendedEmail });
    const mismatch = intendedEmail && token.email && intendedEmail !== token.email
      ? `<p style="color:#a60">Signed in as <strong>${token.email}</strong> but expected <strong>${intendedEmail}</strong>. Reconnect and pick the right Google account.</p>`
      : '';
    res.type('html').send(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
        <h1>Gmail connected</h1>
        <p>Saved OAuth token for Events intake
        (<strong>${token.email || intendedEmail || gmailIntakeAddress()}</strong>). You can close this tab and reopen Settings → Events sources.</p>
        ${mismatch}
        <p><a href="/">Back to dashboard</a></p>
        <script>setTimeout(function(){ location.href='/'; }, 2500);</script>
      </body></html>`,
    );
  } catch (e) {
    res.status(500).type('html').send(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
        <h1>Gmail token exchange failed</h1>
        <p>${String(e?.message || e)}</p>
        <p><a href="/api/events-finder-gmail/oauth/start">Try again</a> · <a href="/">Dashboard</a></p>
      </body></html>`,
    );
  }
});

export default router;
