# CLAUDE.md — agent context

Context for any AI coding agent (Claude Code / Cursor) working this repo.

## What this is

Config-driven **live auction-draft** tool for a private fantasy league. **v1 target: the auction, in person, Aug 2 2026.** Season scoring + rebids are deferred (see `docs/PRD.md` Future). **Public repo** at `github.com/miloli-git/epl-como-fantasy-26-27` — shared tooling only, no real names, no secrets, no private valuation models. Read `docs/PRD.md`, `docs/DATA-MODEL.md`, `docs/HANDOFF.md` before changing anything.

## Stack

- Next.js (App Router, TypeScript), Postgres via `postgres` (postgres.js), live updates by polling `/api/state`.
- One `DATABASE_URL`. Runs self-hosted (Docker, `output: standalone`) and on Vercel from the same code.

## Hard rules

- **Exclusive ownership** is a DB constraint (`picks.player_id` unique). Don't bypass it.
- **No hardcoded league params.** Read from `league.config.json` (real roster overrides via gitignored `league.config.local.json`). Manager count and squad size are always derived from config.
- **Spend/remaining/slots are derived** from `picks` + config at read time. Never store them.
- **Commissioner-gated writes.** `POST/DELETE /api/draft` require `COMMISSIONER_TOKEN`. Reads are open.
- **No real names or secrets in commits.** `.env*` and `league.config.local.json` are gitignored — keep it that way.
- **Before any public push, run the scrub gate:** `git diff --staged` for real manager names / tokens / connection strings; confirm `.env*` and `league.config.local.json` are untracked; confirm no private valuation/projection content. No push if any hit.
- Portability is a requirement: no WebSocket server, no local SQLite, no custom Node server. If a change breaks the Vercel port, it's wrong (see `docs/HANDOFF.md`).

## Build order (when build is approved)

v1 (auction): API routes (`state`, `draft` incl. undo, `players`) → board UI (poll) → projector/big-screen view + commissioner panel. Build `/api/draft` (the no-oversell transaction) via `/dual-harness` — correctness-critical. Deferred: season-score ingest + standings, rebid rounds.

## Verify

After any change: `npm run db:setup && npm run ingest` against a scratch DB, then open the board in a browser and confirm a recorded sale propagates to a second tab. Server 200s alone don't count.
