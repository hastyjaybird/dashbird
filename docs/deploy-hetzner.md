# Hetzner / legacy VPS notes

Active public deploy target is **Vultr Silicon Valley + DuckDNS** — see [`deploy-vultr.md`](deploy-vultr.md).

Historical files (`docker-compose.hetzner.yml`, `deploy/env.hetzner.example`, `scripts/sync-to-hetzner.sh`) may still exist but are superseded by:

| Legacy | Current |
|--------|---------|
| `docker-compose.hetzner.yml` | `docker-compose.cloud.yml` |
| `deploy/env.hetzner.example` | `deploy/env.cloud.example` |
| `scripts/sync-to-hetzner.sh` | `scripts/sync-to-cloud.sh` |
| `deploy/Caddyfile` | `deploy/Caddyfile.cloud` (basic auth required) |

Hetzner US cheap CX tiers are **EU-only**; US Hillsboro CPX is above the project budget. Do not use Hetzner EU as primary (high RTT from Oakland).
