# Deployment - path to production

> Status: **DEPLOYED BETA** at commit `b9d1c5b`, documentation reconciled 15 Jul 2026. Vercel recorded a successful deployment. Runtime observations are dated evidence in `docs/TEST-PLAN.md` and issue #23, not continuing-health claims.
> Production: [epl-como-fantasy-26-27-cgtd.vercel.app](https://epl-como-fantasy-26-27-cgtd.vercel.app). Target: rehearsed and accepted before the pool freeze (Jul 30-31), auction Aug 2.
> Ownership: `docs/PRD.md` holds requirements; `docs/TEST-PLAN.md` holds verification method and latest evidence; issue #9 holds live delivery status; issue #23 holds deployment execution evidence.

This doc describes the production path, accounts, credentials and night-of resilience. Keep execution checkboxes and measured results in issue #23 rather than creating another status surface.

## What runs where (the picture)

The app is a **Next.js website** backed by a **Postgres database**. In production:

- **Vercel** hosts the website at [the stable production URL](https://epl-como-fantasy-26-27-cgtd.vercel.app). It connects to GitHub, watches this repo, and automatically rebuilds and publishes the site every time code lands on `main`. Free (Hobby) tier - sufficient for the intended room size, subject to the pending sustained-load check.
- **Neon** hosts the Postgres database - the system of record on the night. Free tier. The app reaches it through a single secret connection string (`DATABASE_URL`).
- **Anthropic (Claude API)** generates the draft-morning sealed valuations and news briefs. Run as a script from a laptop on draft morning; the auction runs fine without it.
- **FPL public API** supplies the player pool via `npm run ingest`, run from a laptop against the production database. No account needed.

## Decisions (locked 8 Jul 2026)

| Decision | Choice | Why |
|---|---|---|
| Web host | Vercel, Hobby tier, owned by the league's deployment owner | Locked at kickoff; Next.js is first-class there; free tier fits 8 users |
| Deploy trigger | GitHub integration - push to `main` auto-deploys | No manual deploy step to forget; previews per branch for free |
| Database | Neon free tier (created 8 Jul) | One connection string; no idle-pause surprise on auction morning (Supabase free tier pauses after 7 idle days); available as a Vercel-native integration |
| Domain | Stable `epl-como-fantasy-26-27-cgtd.vercel.app` alias | Everyone opens the stable alias once from a shared link/QR; TV set up in advance |
| Claude API | Existing Anthropic Console key (`como-draft`, created 8 Jul) | Reuses existing credits; features degrade gracefully if absent |
| Night resilience | Cloud primary + rehearsed laptop fallback | See "Auction-night resilience" below |
| Auctioneer | A neutral non-manager | Matches the PRD's neutral-operator model; commissioner token goes to their device only, on the night |
| Real roster on Vercel | `LEAGUE_CONFIG_LOCAL` env var holding the JSON override | Vercel cannot see the gitignored local file; the env loader shipped in `1a2c550` and is active in production |

## Accounts checklist

| Account | Status | Owner | Notes |
|---|---|---|---|
| GitHub | ✅ exists | deployment owner | Collaborator access on this repo is in place (confirmed 9 Jul); Vercel signs in with this account |
| Neon (neon.tech) | ✅ created 8 Jul | deployment owner | Free tier; holds the production database |
| Anthropic Console (console.anthropic.com) | ✅ existing key `como-draft` | deployment owner | Small credit balance covers valuations + briefs (realistically a few dollars for ~840 players) |
| Vercel (vercel.com) | ✅ live | deployment owner | Project imported, production env set and commit `b9d1c5b` deployed successfully through the GitHub integration |

## Credentials - what exists and where it lives

Store everything in a password manager. Recommended free setup: **Bitwarden** (bitwarden.com - free, syncs across devices, has a "secure note" type for non-login secrets). One entry per row:

| Credential | What it is | Where it's used | Where it's stored |
|---|---|---|---|
| `DATABASE_URL` | Postgres connection string (looks like `postgresql://user:pass@…neon.tech/db`) | Vercel env settings; local `.env` for ingest/tests | Bitwarden secure note + Vercel env (encrypted at rest). Retrievable any time from the Neon dashboard |
| `COMMISSIONER_TOKEN` | The write password - any long random string you invent. Whoever has it can record sales | Vercel env settings; the auctioneer's device on the night | Bitwarden secure note + Vercel env. Hand to the auctioneer on auction day, not before; rotate (change it in Vercel) after the night |
| `ANTHROPIC_API_KEY` | Claude API key (`como-draft`) | Local `.env` only - the draft-morning job runs from a laptop, so this key **never needs to go into Vercel** | Bitwarden secure note. Revocable/regenerable from the Anthropic Console |
| `LEAGUE_CONFIG_LOCAL` | JSON with the real manager roster (private league facts, not a secret in the password sense) | Vercel env settings | Vercel env; source of truth remains the gitignored `league.config.local.json` on the deployment owner's machine |
| Account logins (GitHub, Vercel, Neon, Anthropic) | Normal username/password + 2FA | - | Bitwarden logins; enable two-factor auth on GitHub and Vercel at minimum |

Rules that keep this safe (also in `CLAUDE.md`):

- `.env` and `league.config.local.json` are gitignored - never commit them, never paste their contents into an issue or doc.
- Keep local copies of `.env` out of shared/synced folders where practical; the password manager is the durable copy.
- Vercel env variables are the only cloud home for secrets; nothing goes in the repo.

## Path to production (the steps, in order)

The one known prerequisite code change, the `LEAGUE_CONFIG_LOCAL` loader, shipped in `1a2c550`. Formal port-walk closure must confirm that no further source change was required.

1. **Collaborator access** - ✅ done 9 Jul.
2. **Create the Vercel account** - ✅ done 8 Jul (GitHub sign-in, Hobby plan).
3. **Import the project** - ✅ live through the Vercel GitHub integration.
4. **Set environment variables** - ✅ `DATABASE_URL`, `COMMISSIONER_TOKEN` and `LEAGUE_CONFIG_LOCAL` are active in production. Keep their values out of this repo.
5. **Prepare the database** - ✅ configured and previously observed. Neon served the real eight-manager roster, 841-player pool and recap payload during the recorded 11 Jul smoke. The issue record does not establish which operational intervention resolved the earlier 500, so do not infer that a specific schema command ran. Production still contains practice state and must be reset before freeze.
6. **Browser smoke test** - partial. A human observed the production board, recap, trades log and player detail routes rendering on 11 Jul. Still use two physical devices to record a test sale via the console, confirm the board updates within ~2s and the reveal fires, and undo it. Server 200s are not sufficient.
7. **Payload audit on production** - recorded at `6e2f5f4`: `/api/state` excluded the value from the unsold current lot, `/api/players` returned `value: null` for all 816 unsold players, and a write without the token returned 401. Repeat the audit after the production reset/freeze against the release candidate.
8. **Record the port walk result** in `docs/PORTING.md` and issue #23. If any code change beyond the shipped roster loader was needed, that is a portability bug to fix in the app.

Ongoing until the freeze: re-run `npm run ingest:stats` from the laptop as needed for price/news drift; **pool freeze Jul 30-31** per the locked decision, after which no ingest runs until after the auction.

## Pre-flight asset cache (at the freeze)

Through July the board pulls player photos and club crests straight from the Premier League CDN (nothing stored, always current). For auction night the board must run off local copies so it does not depend on venue wifi or a third-party CDN - this is the second half of the hybrid image strategy the owners agreed on 9 Jul. The caching pass is a pre-flight step, run once the pool is frozen (Jul 30-31):

1. With `.env` pointing at the production Neon `DATABASE_URL`, and after the final `npm run ingest`, run `npm run assets -- --gentle` from the machine that will serve on the night (and again on the fallback laptop). This downloads every player photo (two sizes) and all 20 club crests into `public/assets/` - about 1,700 files.
2. `--gentle` paces the run to stay under the CDN rate limit. This matters: the CDN (S3 behind CloudFront) blocks an IP that bursts too fast and then returns "403 Access Denied" for every request, including photos that exist, for a cool-off period of tens of minutes. A throttled run would cache silhouettes over real faces. The script detects the throttle signature and exits non-zero with a clear message; if that happens, wait for the block to clear and re-run. A clean run exits zero and writes `public/assets/asset-cache-report.json` with the counts and the exact list of players whose photo is genuinely absent (new signings the CDN has not published yet).
3. Confirm the run was clean: `asset-cache-report.json` shows `"trustworthy": true` and `failed: 0`. Re-check the `missing404` list - those players will show the neutral silhouette on the board (never a broken image), which is acceptable, but re-running the caching pass closer to the auction often picks up photos the CDN has since published.
4. `public/assets/` is gitignored on purpose: the ~1,700 cached binaries are produced per-machine at pre-flight, never committed to the public repo. Each machine that serves on the night (primary and fallback laptop) runs the pass for itself.

Note on the deployed (Vercel) board: Vercel builds from the public repo, which does not contain `public/assets/`, so the deployed board serves photos from the CDN via the built-in fallback (local path first, CDN second, inline silhouette last). Full local-copy independence applies to the fallback laptop, which is exactly the surface that must keep working if venue wifi or the CDN is unavailable. See "Auction-night resilience".

Draft morning (Aug 2): run the valuations + briefs job from the laptop with `ANTHROPIC_API_KEY` set, against the production `DATABASE_URL`. If it fails, the panels hide and the auction proceeds.

## Auction-night resilience

Primary: the Vercel URL over venue internet. Rehearsed fallback (part of the Run 4 dress rehearsal):

- One laptop in the room has the repo, `npm install` done, and a `.env` pointing at the production Neon database.
- **Venue wifi dies:** phone hotspot on the laptop + TV; the room's phones join the hotspot; the Vercel URL keeps working. (Most likely failure, cheapest fix.)
- **Vercel is down (rare):** laptop runs `npm run build && npm start` against the same Neon database; TV and phones point at the laptop's local address. Same data, same state - nothing is lost because the database, not the website, is the system of record.
- **Neon is down (rarest):** pre-night `pg_dump` snapshot + a local Postgres (Docker) on the laptop as cold standby; the drill for restoring is written in the runbook before the rehearsal.
- Paper ledger printout of budgets/rosters as the absolute last resort, reconciled into the app afterwards (edit/void exists for exactly this).

The fallback app path uses `npm run build` then `npm start`. `output: standalone` can support future container packaging, but this repo has no Dockerfile. The hotspot, laptop and cold-standby drills remain pending and do not count until each is executed and timed.

## Timeline (maps to issue #9)

| When | What |
|---|---|
| Now | Merge the documentation reconciliation; align issues #9 and #23; prepare the reset/freeze, post-reset audit, two-device mutation check and physical rehearsal |
| Run 4 (Jul 28-Aug 1) | Failure drills, runbook + auctioneer cheat sheet, dress rehearsal on the production URL, audit scrub |
| Jul 30-31 | Pool freeze - final ingest, then the asset caching pass (`npm run assets -- --gentle`) on the serving machine and the fallback laptop, then hands off the player table |
| Aug 2, morning | Valuations + briefs job; pre-flight checklist; re-run the asset caching pass to pick up any newly published photos |
| Aug 2, night | The auction. Token to the auctioneer; fallback laptop in the room |
| Aug 3+ | Rotate `COMMISSIONER_TOKEN`; run the recap archive and preserve the final ledger |

## Open items

1. **Acceptance evidence** - production reset/freeze and post-reset audit; formal two-device sale/reveal/undo; 10-tab sustained load; physical TV, hotspot, laptop and cold-standby drills. The scratch workflow is documented in `docs/TEST-RUN-RESET.md`; execution evidence remains in issue #23.
2. **Auctioneer identity** - decided as "a neutral non-manager"; the specific person to be confirmed by Jul 28 so the cheat-sheet handoff and token delivery are planned.
3. **2025 rosters** for the prior-owner line - still being hunted; feature hides gracefully without it.
