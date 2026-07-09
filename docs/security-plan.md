# Dashbird cybersecurity plan

Lightweight security plan for **local LAN-only** dashbird. No dashboard login is required for the current deployment model: access control is **network boundary** (trusted home Wi‑Fi, no port-forwarding). A password on the app itself would add friction without meaningful protection while the service remains LAN-reachable without auth.

## 1) Ownership and review cadence

- Security owner: repo maintainer (default: Jay).
- **Weekly:** dependency review (`npm audit`), skim logs for anomalies.
- **Monthly:** secrets checklist + run core smoke (`npm run smoke:core`).
- **Per meaningful release:** security review pass on changed routes and env handling.

## 2) Threat model (local LAN)

| Risk | Mitigation |
|------|------------|
| Anyone on LAN opens dashboard | Accept for trusted home Wi‑Fi; do **not** port-forward 8787 to the internet |
| Leaked API keys in git | `.env` gitignored; rotate on exposure |
| Dependency vulnerabilities | `npm audit` + triage |
| Upstream fetch abuse / SSRF-style bugs | Validate URLs, timeouts, allowlists where applicable |
| Secrets in logs/telemetry | Never log keys; ratings telemetry is non-PII |

## 3) Secrets handling

- Never commit secrets, API keys, tokens, or private URLs.
- Runtime secrets live in `.env` only.
- `.env.example` holds placeholders only.
- On exposure: revoke/rotate immediately, then re-test integrations.

## 4) Dependency and supply-chain hygiene

- Use `npm install` / `npm update` — avoid hand-editing lockfiles.
- Before new dependencies: check maintainer activity and known issues.
- Run `npm audit` after dependency changes; record accepted risks with reason.

## 5) Security audit program (roadmap execution)

Recurring audit stack — **no vendor billing re-sync required**:

| Check | When | Tool |
|-------|------|------|
| Dependency vulnerabilities | Weekly + on dep changes | `npm audit` |
| Automated dependency PRs | Ongoing (if enabled) | Dependabot |
| Static analysis | Monthly or on large diffs | Semgrep (or equivalent) |
| AI-assisted review | On meaningful feature PRs | Cursor security review |
| Runtime sanity | Before/after deploy | `npm run smoke:core` |

For each finding: severity, owner, fix or documented accept-with-reason, target date.

## 6) Runtime/API hardening

- Validate and sanitize request input on server routes.
- Fail closed when external provider keys are missing.
- Conservative timeouts on upstream `fetch`.
- Avoid leaking stack traces or internal paths in API errors.

## 7) Logging and telemetry

- Tool library ratings telemetry (`/api/tool-library/ratings/debug`) tracks source, null-rate, latency — no secrets/PII.
- Trim or rotate container logs on long-running hosts if needed.

## 8) Incident response (quick)

1. Contain — stop container or disable affected route.
2. Rotate — revoke exposed secrets.
3. Assess — scope (routes, data, keys).
4. Recover — patch and redeploy (`docker compose down && docker compose up -d --build`).
5. Verify — `npm run smoke:core` + targeted checks.
6. Document — timeline and prevention.

## 9) Backlog

- CI gate for `npm audit` + smoke on push (optional).
- Periodic dependency update automation with manual approval.
- Security review when adding non-OpenRouter AI providers (v2).
