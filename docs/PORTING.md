# Porting - NAS reference → Vercel

> The portability claim is a v1 acceptance criterion, not a hope. This walk must complete with **no code change**. If it doesn't, that's a bug to fix in the app, not to patch around in the deploy.

## Why it ports cleanly

| Usual serverless blocker | This repo's choice |
|---|---|
| Long-lived WebSocket server | live updates by polling `/api/state` |
| Local SQLite on ephemeral FS | Postgres via `DATABASE_URL` |
| Custom Node server | Next.js App Router (`output: standalone` for Docker; Vercel uses its own build) |
| Background workers | FPL ingest is a plain `npm run ingest` script |

## The walk (the porter's agent runs this)

1. Clone the repo. Read `CLAUDE.md`, `docs/HANDOFF.md`, `docs/DATA-MODEL.md`.
2. Provision Postgres (Neon/Supabase free tier).
3. In Vercel project settings, set env: `DATABASE_URL`, `COMMISSIONER_TOKEN`.
4. Locally against the hosted DB: `npm install` → `npm run db:setup` → `npm run ingest`.
5. `vercel deploy`. Expect zero source changes.
6. Set the real roster: Vercel can't read the gitignored `league.config.local.json`. **Decided (8 Jul 2026):** the config loader reads a `LEAGUE_CONFIG_LOCAL` env var containing the same JSON, applied with the same deep merge, with the local file taking precedence when both exist. Paste the file's contents into that Vercel env var. (Loader change tracked as an issue until it lands.)
7. **Verify in a browser:** open the deployed URL, record a sale on the commissioner panel, confirm it appears on the board view within ~2s.

## If a code change was required

Log it as an issue and fix the *app* so the next port is clean. Record the failure here so the claim stays honest.

## Self-host (reference, for parity)

- `docker build` with `output: standalone`; pass `DATABASE_URL` + `COMMISSIONER_TOKEN` as env (volume-mount or env file - do not bake secrets into the image).
- Recreate a running container with `docker compose up -d --force-recreate` (plain `--build` will NOT replace a running container).
