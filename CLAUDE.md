# CLAUDE.md - agent context

Context for any AI coding agent (Claude Code / Cursor) working this repo.

## What this is

Config-driven **live auction-draft** tool for a private fantasy league. **v1 target: the auction, in person, Aug 2 2026.** Season scoring never lives here (the official FPL Draft site runs the season). **Public repo** at `github.com/Kolam-Studios/epl-como-fantasy-26-27` - shared tooling only, no real names, no secrets, no private valuation content. Read `docs/PRD.md`, `docs/DESIGN.md`, `docs/DATA-MODEL.md`, `docs/HANDOFF.md` before changing anything.

## Current state + where to start (2026-07-15)

- **Decisions are made.** The league owners have locked scope: $3,000 x 8 managers, four config-driven tiers, two-phase auction with phase-2 nomination rotation, commissioner-entry bidding, in-auction trades in v1, edit/void any sale with audit, sealed draft-morning valuations revealed at the hammer, war-room model with ~2s polling. `docs/DECISIONS-TO-CONFIRM.md` is the decision table; `docs/PRD.md` and `docs/DESIGN.md` are the requirements of record.
- **A v1 feature beta is deployed** at commit `b9d1c5b`: [production](https://epl-como-fantasy-26-27-cgtd.vercel.app). Core auction flow, corrections, trades, sealed reveals, recap, read-only trade log, #55 phone fix, additive schema migrations, stage tags and expanded standard player stats are implemented. The integrated runner has 16 suites, including the read-only trades suite. Dated runtime observations belong in issue #23 rather than this file. Remaining Aug 2 gates are production reset/freeze, the post-reset audit and the formal two-device, load and physical/fallback rehearsal.
- **Follow [issue #9](https://github.com/Kolam-Studios/epl-como-fantasy-26-27/issues/9) for live delivery status.** Requirements live in `docs/PRD.md`; verification method and latest evidence live in `docs/TEST-PLAN.md`; deployment execution evidence lives in issue #23. Do not create another status surface.
- **Where docs conflict, `docs/DESIGN.md` and `docs/PRD.md` are correct** (the max-bid rule reserves the minimum opening bid per open slot, config-driven).
- The current visual design is implemented. See `docs/VISUAL-DESIGN.md` and `docs/wireframes/` for the locked system and reference screens.
- Vercel, Neon and the real roster override are live. Complete the remaining formal port-walk evidence and physical drills in `docs/PORTING.md` and `docs/TEST-PLAN.md` before acceptance.

## Human confirmation gates

Decisions for the human driving, not the agent. Stop and ask; never assume, guess, or build past them:

1. **League facts:** the real roster (names go ONLY in gitignored `league.config.local.json`), pool-freeze date, auctioneer identity, draft-night hosting. Never guess these and never commit them.
2. **Anything the scrub gate flags** (see Hard rules). When in doubt about whether content is private, it is; ask.

## Stack

- Next.js (App Router, TypeScript), Postgres via `postgres` (postgres.js), live updates by polling `/api/state` (~2s).
- One `DATABASE_URL`. Production runs on Vercel. The verified laptop fallback is `npm run build` then `npm start` against Postgres. `output: standalone` supports future container packaging, but no Dockerfile is present in this repo.
- Claude API for the draft-morning briefs + valuations job only; the auction must run fine without it.

## Hard rules

- **Exclusive ownership** is a DB constraint (`sales.player_id` unique). Don't bypass it.
- **No hardcoded league params.** Read from `league.config.json` (real roster overrides via gitignored `league.config.local.json`, deep-merged at runtime). Manager count, budget, squad shape, tier bands/opens are always derived from config.
- **Spend/remaining/slots/max-bids are derived** from sales + trades + config at read time. Never store them.
- **Sale legality is enforced server-side** (max bid, tier open, position quota, squad size). Client greying is UX, not defence.
- **Sealed valuations never appear in any payload for an unsold player.** Sealing is server-side, not CSS.
- **Every mutation writes an audit row** (sale create/edit/void, trade, phase change).
- **Commissioner-gated writes.** All write routes require `COMMISSIONER_TOKEN`. Reads are open.
- **No real names or secrets in commits.** `.env*` and `league.config.local.json` are gitignored - keep it that way.
- **Before any public push, run the scrub gate:** `git diff --staged` for real manager names / tokens / connection strings; confirm `.env*` and `league.config.local.json` are untracked; confirm no sealed values or private valuation methodology beyond what the group agreed to publish. No push if any hit.
- Portability is a requirement: no WebSocket server, no local SQLite, no custom Node server. If a change breaks the Vercel port, it's wrong (see `docs/HANDOFF.md`).

## Build order

Sprint sequence lives in issue #9. `/api/draft` (the no-oversell transaction) is correctness-critical: build it with an adversarial review pass (try to break your own transaction with concurrent requests) before it counts as done. Deferred to later versions: rebid rounds, historical archive import.

## Verify

After any change: `npm run db:setup && npm run ingest` against a scratch DB, then open the board in a browser and confirm a recorded sale propagates to a second tab (and fires the reveal). Server 200s alone don't count.
