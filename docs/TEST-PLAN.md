# Test plan - verification against v1 acceptance criteria

> Status: baseline verified 8 Jul 2026 (post-Run 1). This doc is written for a coding agent to execute as part of each build run and, in full, during Run 4.
> The criteria of record are in `docs/PRD.md` § Acceptance criteria. Nothing here redefines them; this maps each to a concrete, runnable check.

## How to run

All DB-backed suites need a `.env` with `DATABASE_URL` (use a scratch database, never production, for anything that writes). Every suite is self-cleaning, but treat that as a courtesy, not a guarantee.

```bash
npm install
npm run db:setup && npm run ingest        # fresh schema + real pool
npm run test:derive                       # pure rules math (no DB)
node scripts/test-config.mjs              # config merge + tier logic (no DB)
node --env-file=.env scripts/test-schema.mjs
npm run test:state
npm run test:draft
npm run test:draft-concurrency
npm run test:corrections
npm run test:lot
node --env-file=.env scripts/test-ingest.mjs
npm run test:ui                           # end-to-end against a running `npm run dev`
npm run build                             # must exit 0 with no type errors
```

A criterion counts as PASS only when the agent has run the check in this table and seen the expected output - not because a previous report said so.

## Criterion-by-criterion status and test cases

Legend: ✅ verified 8 Jul 2026 on this machine against a live Neon DB · 🔜 pending a later run · each row names the check an agent runs.

| # | PRD criterion | Status | Test case for the agent |
|---|---|---|---|
| 1 | `db:setup` + `ingest` → populated tiered pool, seeded managers | ✅ | Run both against a fresh DB. Assert: players table > 500 rows, positions ∈ {GK,DEF,MID,FWD} only, every player has a tier matching its price band per config, manager count equals config array length. Covered by `test-schema` (4 checks) + `test-ingest` (6) |
| 2 | Invalid sales rejected server-side with a clear reason | ✅ | `test:draft` (33+ checks): below tier open, over max bid, position full, squad full, double-sale, wrong player, paused, missing/bad token. Each rejection message must name the rule and the number |
| 3 | Console→board propagation ≤ ~2s + reveal fires | ✅ (local) 🔜 (deployed) | `test:ui` (23 checks) drives dev server via API and asserts board state flips. **Run 4 repeats this on the production URL with two physical devices and a human watching** - server 200s explicitly insufficient (PRD) |
| 4 | Invariants hold; concurrent sales cannot oversell | ✅ | `test:draft-concurrency`: 10 simultaneous conflicting sales → exactly 1 lands, spend ≤ budget, version bumps exactly once. Run 3×; any run landing ≠1 is a FAIL |
| 5 | Undo reverses; edit/void re-validates + audit row | ✅ | `test:corrections` (35 checks): undo restores player + budget; edit re-validates (incl. the double-counting trap); void mid-reveal handles newest-vs-older correctly; every mutation has an audit row with before/after + reason |
| 6 | Trades move players/salaries/cash; illegal trades rejected | 🔜 Run 3 | **To write with the feature:** trade a player + cash, assert both budgets/max-bids recalc exactly; assert rejects for negative budget, quota breach, squad >15. Must include a concurrency case (trade racing a sale for the same player) and audit rows. Open bugs #15 and #18 (state/rotation must derive through trades) become regression cases here |
| 7 | Phase 1→2 transition; no-bids nominatable; rotation skips full; ends 15/15 | ✅ (engine + full-night drill) | `test:lot` (62 checks): end-phase-one refuses while lot unresolved or players unoffered; nomination rotation order enforced; full squads skipped. **Run 4 full-auction drill DONE** (`test-full-night.mjs`, 19 checks, in the battery): drives the whole real pool through phase 1 (sales + no-bids), endPhaseOne, and phase 2 to every squad exactly 15/15, cross-checking in-memory bookkeeping vs raw SQL vs the `/api/state` derivation. Scope: proves completion + invariants buying at opening-bid prices; competitive/over-max bidding and contested nominations stay covered by `test:draft` / `test:draft-concurrency` / `test:lot` (the drill adds one integration over-max rejection smoke check) |
| 8 | Sealed valuations never in any payload for unsold players | ✅ (local) 🔜 (deployed) | `test:state` asserts structural exclusion. **Run 4 on production:** `GET /api/state` and every other route with an unsold player present; grep the raw JSON for valuation fields - zero hits. Also assert a write without `COMMISSIONER_TOKEN` is refused on the production URL |
| 9 | Config change honoured with no code change | ✅ (partial) | `test-config` (13 checks) covers tiers/opens/merge. **Run 4 adds:** boot the app against a variant config (different budget, 6 managers, different squad shape); assert `/api/state` derives everything from it - no code change, no hardcoded 8s or 3000s |
| 10 | Port walk completes with no code change | 🔜 blocked | Blocked on the `LEAGUE_CONFIG_LOCAL` env-override change (see roster issue). Then execute `docs/PORTING.md` + `docs/DEPLOYMENT.md` steps 1-8 verbatim and record the result in PORTING.md |
| 11 | Browser smoke test on the deployed URL, human-confirmed | 🔜 Run 4 | Two devices on the production URL: record a sale with the token, watch the board update ≤2s and the reveal fire, undo it. A human confirms visually; screenshot into the run report |

## Deployment-specific test cases (new - for Run 4)

These go beyond the PRD list and exist because of decisions in `docs/DEPLOYMENT.md`:

1. **Roster env override:** with `LEAGUE_CONFIG_LOCAL` set (and no local file present, as on Vercel), assert real manager names appear on the board and the placeholder names do not. With neither set, placeholders render.
2. **Token rotation:** change `COMMISSIONER_TOKEN` in Vercel env + redeploy; old token refused, new accepted.
3. **Polling load sanity:** 10 browser tabs polling `/api/state` for 10 minutes against production; no 5xx, no Neon connection exhaustion (postgres.js pool vs Neon free-tier connection limit - if exhausted, that's a bug to fix, e.g. pooled connection string).
4. **Fallback drill (timed):** kill venue-wifi assumption - laptop `npm start` against Neon; TV repointed; a sale recorded and propagated. Target: room back live in under 10 minutes. Then the cold-standby restore: `pg_dump` → local Postgres → app up read-correct.
5. **Freeze guard:** with `pool_frozen` set, `npm run ingest` refuses (already covered in `test-ingest`; re-verify against production DB before Jul 30).
6. **Draft-morning job dry run (Run 3+):** run valuations + briefs against a scratch DB with a real API key; assert every unsold player gets a valuation, values respect the league economy calibration, and the job's failure mode (no key / API down) leaves the app fully functional with panels hidden.

## Baseline record (8 Jul 2026)

Full battery run on Windows 11, Node 24, against the production Neon instance (pre-launch, so writes were acceptable this once): schema 4, config 13, derive 19, state 7, draft 33+, concurrency 12×3, corrections 35, lot 62, ingest 6, UI 23 - **all PASS**. `npm run build` exits 0. From Run 2 onward, DB-backed suites run against a scratch database only.

Run 4 update (8 Jul 2026): the full battery is now run via `node --env-file=.env scripts/test-all.mjs`, which creates a throwaway scratch database, applies the schema, ingests the pool, runs every suite (now including the new `full night` drill, 19 checks), and drops the scratch DB - production is never written. Latest run: **13/13 suites PASS** (derive, club, schema, config, ingest, state, players, draft, draft concurrency, corrections, trade, lot, full night).
