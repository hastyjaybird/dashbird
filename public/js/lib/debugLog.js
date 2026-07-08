const ENDPOINT = 'http://127.0.0.1:7859/ingest/71d5535c-29f1-469d-989c-03aab09039cd';
const SESSION_ID = '3f30cd';

/** @param {{ location: string, message: string, data?: Record<string, unknown>, hypothesisId?: string, runId?: string }} payload */
export function debugLog(payload) {
  const body = { sessionId: SESSION_ID, timestamp: Date.now(), ...payload };
  // #region agent log
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION_ID },
    body: JSON.stringify(body),
  }).catch(() => {});
  // #endregion
}
