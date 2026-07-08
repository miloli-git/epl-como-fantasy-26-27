# Handoff - Reference build and Vercel port

> Status: DRAFT for review.

Repo: `github.com/miloli-git/epl-como-fantasy-26-27` (public, MIT). v1 scope is the **live auction only** (in person, Aug 2 2026); season scoring + rebids are deferred.

## The split

- **Maintainer** builds the reference app and runs it self-hosted (Docker + Postgres). This repo is the source of truth.
- **Porter** has no homelab. Their AI coding agent **clones this repo, reviews it, and ports the deploy to a Vercel-equivalent.** The stack is chosen so this is a deploy-target swap, not a rewrite.

## Why the port is cheap

Every piece that would normally break a serverless port has been avoided up front:

| Usual blocker | Our choice | Result |
|---|---|---|
| Long-lived WebSocket server | live updates by **polling** `/api/state` | no server to host; works on serverless unchanged |
| Local SQLite file on ephemeral FS | **Postgres** via a `DATABASE_URL` | same connection string from self-host or Vercel |
| Custom Node server | **Next.js** App Router | first-class on Vercel; self-hosts via `output: standalone` |
| Background workers | FPL ingest is a **plain script** (`npm run ingest`) | run manually or as a cron |

## Porter's agent - port checklist

See `docs/PORTING.md` for the full walk. In short: clone → provision Postgres → set env → `db:setup` + `ingest` → `vercel deploy` → verify in a browser. No source change should be required; if one is, that's a portability bug to fix in the app.

## What is reference-only vs portable

- **Portable (ships as-is):** all app code, schema, config, ingest, API routes.
- **Reference-only (not in this repo):** the maintainer's Docker/compose, any reverse-proxy/Cloudflare routing, and any private valuation/projection work. The porter doesn't need these.

## Confidentiality

This repo is **public**. It must never contain: real manager names (use the placeholder config; real roster goes in gitignored `league.config.local.json`), secrets/tokens (`.env*` is gitignored), or any manager's private strategy/valuation model. Run the scrub gate in `CLAUDE.md` before every push.
