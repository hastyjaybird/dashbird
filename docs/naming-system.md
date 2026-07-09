# Naming System

This document defines naming conventions across local folders, GitHub repositories, domains, and servers.

## 1) Canonical Names

- Brand (display): `Corvidae Studio`
- Brand slug (systems): `corvidaestudio`
- Personal dashboard slug: `dashbird`

Slug rules for all new projects:
- lower-case only
- letters, numbers, hyphens
- no spaces or underscores
- keep names short and intention-revealing

Examples:
- `vc-dashboard`
- `research-lab`
- `portfolio-site`

## 2) Local Folder Layout

Use separate company and personal roots:

- `/home/jaybird/projects/company/corvidaestudio/`
- `/home/jaybird/projects/personal/`

Project placement:
- Company projects: `/home/jaybird/projects/company/corvidaestudio/<project-slug>/`
- Personal projects: `/home/jaybird/projects/personal/<project-slug>/`

Example:
- `/home/jaybird/projects/company/corvidaestudio/vc-dashboard/`
- `/home/jaybird/projects/personal/dashbird/`

## 3) GitHub Repository Naming (personal account)

All repositories currently stay under the personal account.

Prefix policy:
- Company products: `cs-<project-slug>`
- Personal tools: `<project-slug>` (or `personal-<project-slug>` if needed later)

Current project:
- `dashbird` (keep as-is)

Future examples:
- `cs-corvidaestudio-site`
- `cs-vc-dashboard`
- `cs-research-lab`

## 4) Server Naming Convention

Use one server per externally exposed app by default.

Format:
- `<scope>-<app>-<env>-<nn>`

Scopes:
- `cs` for company products
- `personal` for private tools

Examples:
- `cs-web-prod-01`
- `cs-vc-prod-01`
- `personal-dashbird-prod-01`

## 5) Domain and Subdomain Convention

- Brand root: `corvidaestudio.com`
- Company app pattern: `<app>.corvidaestudio.com`
- Portfolio index (optional): `projects.corvidaestudio.com`
- Private personal app pattern: `<app>.<personal-domain>`

If using brand DNS for private tools, isolate with clear naming:
- `private-dashbird.corvidaestudio.com`

## 6) Exposure Tiers

- Tier 1 Public: no login required, portfolio-ready
- Tier 2 Friend Demo: protected login, controlled sharing
- Tier 3 Private: owner-only (Dashbird)

Map each project to a tier before deployment.

## 7) Dashbird defaults

Dashbird is a personal private tool, **local LAN only** for this project:
- Folder root: `projects/personal` (or current workspace path)
- Repo name: `dashbird`
- Deployment: Docker Compose on home network — **no public VPS / Hetzner** in active scope
- Access control: trusted LAN boundary; **no dashboard login** in the current model (do not port-forward to the internet)

