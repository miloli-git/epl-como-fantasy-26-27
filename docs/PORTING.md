# Porting - NAS reference → Vercel

> The portability claim is a v1 acceptance criterion, not a hope. This walk must complete with **no code change**. If it doesn't, that's a bug to fix in the app, not to patch around in the deploy.
> Observed 11 Jul 2026: commit `b9d1c5b` is deployed at [epl-como-fantasy-26-27-cgtd.vercel.app](https://epl-como-fantasy-26-27-cgtd.vercel.app) with Neon and the real roster override. The deployment, recap and read-only viewer smoke are green. Operational and formal port-walk closure remain pending.

## Why it ports cleanly

| Usual serverless blocker | This repo's choice |
|---|---|
| Long-lived WebSocket server | live updates by polling `/api/state` |
| Local SQLite on ephemeral FS | Postgres via `DATABASE_URL` |
| Custom Node server | Next.js App Router; Vercel uses its native build. `output: standalone` can support future container packaging, but this repo has no Dockerfile |
| Background workers | FPL ingest is a plain `npm run ingest` script |

## The walk (the porter's agent runs this)

1. Clone the repo. Read `CLAUDE.md`, `docs/HANDOFF.md`, `docs/DATA-MODEL.md`.
2. Provision Postgres (Neon/Supabase free tier).
3. In Vercel project settings, set env: `DATABASE_URL`, `COMMISSIONER_TOKEN`, `LEAGUE_CONFIG_LOCAL`.
4. Locally against the hosted DB: `npm install` → `npm run db:setup` → `npm run ingest`.
5. Deploy through the Vercel GitHub integration. Expect zero source changes after the roster loader in `1a2c550`.
6. Set the real roster: Vercel can't read the gitignored `league.config.local.json`. The shipped config loader reads a `LEAGUE_CONFIG_LOCAL` env var containing the same JSON, applies the same deep merge, and gives the local file precedence when both exist. Paste the file's contents into that Vercel env var.
7. **Verify in a browser:** open the deployed URL, record a sale on the commissioner panel, confirm it appears on the board view within ~2s.

## Current evidence (11 Jul 2026)

- Vercel reports a successful production deployment for commit `b9d1c5b` through the stable production URL.
- The app is connected to Neon and renders the real eight-manager override plus the 841-player pool.
- Read-only production checks observed the board and read routes rendering, no non-null value for any of 816 unsold players, and a 401 for an unauthenticated write.
- Production `/api/recap` returns 200, and the browser renders awards, final squads, FPL Draft checklists and the ledger link. `/trades` and player detail also render against live data.
- Still required for closure: reset/freeze production and repeat the audit, record that no source change beyond the already-shipped roster loader was needed, run the two-device sale/reveal/undo check, then complete the sustained-load and physical/fallback drills in `docs/TEST-PLAN.md`.

## If a code change was required

Log it as an issue and fix the *app* so the next port is clean. Record the failure here so the claim stays honest.

## Laptop fallback and future packaging

- The verified fallback path is `npm run build` then `npm start`, with `DATABASE_URL` and `COMMISSIONER_TOKEN` provided through the environment.
- `output: standalone` provides the build seam for future container packaging. No Dockerfile or Compose file is present, so Docker app hosting is not currently a packaged or verified repo capability.
