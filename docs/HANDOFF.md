# Handoff - Application and Vercel deployment

> Status: Vercel beta deployed at commit `b9d1c5b`; recap and read-only viewer smoke are green, while final rehearsal and acceptance remain pending.

Repo: `github.com/Kolam-Studios/epl-como-fantasy-26-27` (public, MIT). Production: [epl-como-fantasy-26-27-cgtd.vercel.app](https://epl-como-fantasy-26-27-cgtd.vercel.app). v1 scope is the **live auction only** (in person, Aug 2 2026); season scoring + rebids are deferred.

## The split

- **Maintainer** builds the application and owns its requirements and verification record in this repo.
- **Deployment owner** runs the Vercel + Neon production path and records execution evidence in issue #23. The stack keeps the laptop fallback a build-and-start operation, not a rewrite.

## Why the port is cheap

Every piece that would normally break a serverless port has been avoided up front:

| Usual blocker | Our choice | Result |
|---|---|---|
| Long-lived WebSocket server | live updates by **polling** `/api/state` | no server to host; works on serverless unchanged |
| Local SQLite file on ephemeral FS | **Postgres** via a `DATABASE_URL` | same connection string from self-host or Vercel |
| Custom Node server | **Next.js** App Router | first-class on Vercel; `npm run build` + `npm start` is the verified laptop fallback |
| Background workers | FPL ingest is a **plain script** (`npm run ingest`) | run manually or as a cron |

## Porter's agent - port checklist

See `docs/PORTING.md` for the full walk. The Vercel + Neon path and real roster override are green at `b9d1c5b`; the read-only production audit was observed at `6e2f5f4`. Production `/api/recap` returns 200, and the browser renders awards, final squads, FPL Draft checklists and the ledger link. The remaining handoff gate is to reset/freeze production, repeat the audit, then record the two-device sale/reveal/undo check, sustained load and physical/fallback drills. No further source change should be required after the shipped roster loader; if one is, that is a portability bug to fix in the app.

## What is reference-only vs portable

- **Portable (ships as-is):** all app code, schema, config, ingest, API routes.
- **Fallback:** `npm run build` then `npm start` against Postgres. `output: standalone` supports future container packaging, but this repo has no Dockerfile or Compose file.
- **Private and external:** any reverse-proxy routing, environment credentials and private valuation/projection work stay outside this public repo.

## Confidentiality

This repo is **public**. It must never contain: real manager names (use the placeholder config; real roster goes in gitignored `league.config.local.json`), secrets/tokens (`.env*` is gitignored), or any manager's private strategy/valuation model. Run the scrub gate in `CLAUDE.md` before every push.
