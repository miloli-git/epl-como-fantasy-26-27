# Test plan - verification against v1 acceptance criteria

> Status: source evidence reconciled 11 Jul 2026 at commit `b9d1c5b`. Issues #48 and #50 remain the recorded isolated 15-suite baseline; the landed read-only trades work adds a sixteenth suite and reports the full battery green. Production `/api/recap` returns 200, and the browser renders awards, final squads, FPL Draft checklists and the ledger link.
> The criteria of record are in `docs/PRD.md` section "Acceptance criteria". Nothing here redefines them; this doc owns the verification method and latest evidence for each criterion.

## How to run

All DB-backed suites need a `.env` with `DATABASE_URL` (use a scratch database, never production, for anything that writes). Every suite is self-cleaning, but treat that as a courtesy, not a guarantee.

```bash
npm install
npm run db:setup && npm run ingest        # fresh schema + real pool
npm run test:derive                       # pure rules math (no DB)
npm run test:club                         # pure club-colour mapping (no DB)
node scripts/test-config.mjs              # config merge + tier logic (no DB)
node --env-file=.env scripts/test-schema.mjs
npm run test:state
npm run test:players
node --env-file=.env scripts/test-player-detail.mjs
npm run test:recap
npm run test:draft
npm run test:draft-concurrency
npm run test:corrections
npm run test:trade
node --env-file=.env scripts/test-trades.mjs
npm run test:lot
node --env-file=.env scripts/test-full-night.mjs
node --env-file=.env scripts/test-ingest.mjs
npm run test:ui                           # end-to-end against a running `npm run dev`
npm run build                             # must exit 0 with no type errors
```

For the integrated pre-freeze gate, run `node --env-file=.env scripts/test-all.mjs` against a throwaway scratch database. The runner now restores the exact post-ingest baseline before every suite and retries one failed suite once from another clean reset, logging any retry in the summary. This documentation reconciliation did not rerun any DB-backed suite; the recorded green run is the landed #48/#50 evidence.

A criterion counts as PASS only when the agent has run the check in this table and seen the expected output - not because a previous report said so.

## Criterion-by-criterion status and test cases

Legend: ✅ verified by the recorded evidence · 🔜 pending a later run · partial means only the named portion has been observed. The current integrated battery evidence is for commit `b9d1c5b`.

| # | PRD criterion | Status | Test case for the agent |
|---|---|---|---|
| 1 | `db:setup` + `ingest` → populated tiered pool, seeded managers | ✅ current battery | Run both against a fresh DB. Assert: players table > 500 rows, positions ∈ {GK,DEF,MID,FWD} only, every player has a tier matching its price band per config, manager count equals config array length. Covered by the schema and ingest suites. `db:setup` is now additive and re-running it preserves recorded sales |
| 2 | Invalid sales rejected server-side with a clear reason | ✅ | `test:draft` (33+ checks): below tier open, over max bid, position full, squad full, double-sale, wrong player, paused, missing/bad token. Each rejection message must name the rule and the number |
| 3 | Console→board propagation ≤ ~2s + reveal fires | ✅ (local) 🔜 (deployed) | `test:ui` (23 checks) drives dev server via API and asserts board state flips. **Run 4 repeats this on the production URL with two physical devices and a human watching** - server 200s explicitly insufficient (PRD) |
| 4 | Invariants hold; concurrent sales cannot oversell | ✅ | `test:draft-concurrency`: 10 simultaneous conflicting sales → exactly 1 lands, spend ≤ budget, version bumps exactly once. Run 3×; any run landing ≠1 is a FAIL |
| 5 | Undo reverses; edit/void re-validates + audit row | ✅ | `test:corrections` (35 checks): undo restores player + budget; edit re-validates (incl. the double-counting trap); void mid-reveal handles newest-vs-older correctly; every mutation has an audit row with before/after + reason |
| 6 | Trades move players/salaries/cash; illegal trades rejected | ✅ current battery | `test:trade` covers player and cash movement, exact budget/max-bid recalculation, negative budget, quota and squad guards, audit rows, corrections after trades, the #15/#18 derivation regressions and a sale/trade race. The console trade-entry UI is live |
| 7 | Phase 1→2 transition; no-bids nominatable; rotation skips full; ends 15/15 | ✅ current battery | `test:lot` covers phase transition and nomination rotation. `test-full-night.mjs` drives the whole real pool through phase 1 and phase 2 to every squad exactly 15/15, cross-checking in-memory bookkeeping, raw SQL and `/api/state` derivation. Competitive and contested cases remain covered by the draft, draft-concurrency and lot suites |
| 8 | Sealed valuations never in any payload for unsold players | ✅ current battery + production read-only audit | The state, players, player-detail and recap suites assert structural sealing. On production at `6e2f5f4`, `/api/state` excluded the value from the unsold current lot, `/api/players` returned `value: null` for all 816 unsold players, and an unauthenticated write returned 401. Repeat the production audit after reset/freeze |
| 9 | Config change honoured with no code change | ✅ loader tests + deployed roster override · 🔜 full variant app boot | `test-config` now has 22 checks, including env-only override, file precedence and malformed env failure. Production renders the real eight-manager override from `LEAGUE_CONFIG_LOCAL`. Still boot the full app against a variant budget, manager count and squad shape before production acceptance |
| 10 | Port walk completes with no code change | ✅ deployment green · 🔜 operational + formal closure | Vercel is green at `b9d1c5b` against Neon with the real override. Recap and the read-only viewer routes render against live data. Record in `docs/PORTING.md` and issue #23 that no further source change was required after the known roster loader, then complete the mutation and fallback evidence |
| 11 | Browser smoke test on the deployed URL, human-confirmed | ✅ read-only browser smoke · 🔜 formal two-device mutation | Vercel reports the `b9d1c5b` production deployment successful; a human observed the board, recap, trades log and player detail routes rendering. Still use two physical devices to record a sale with the token, watch the board update within ~2s and the reveal fire, then undo it. Capture the result in issue #23 |

## Deployment-specific test cases (new - for Run 4)

These go beyond the PRD list and exist because of decisions in `docs/DEPLOYMENT.md`:

Current evidence at `b9d1c5b`: Vercel is green; the integrated runner contains 16 suites; #55 and #56 are closed; and the recap, trades log and expanded standard player detail render in production. Neon, the real roster override and the earlier read-only payload/token audit were observed. Formal production reset/freeze, post-reset audit, two-device mutation, 10-tab sustained-load run, physical TV check, hotspot drill, laptop fallback and cold-standby restore are pending.

1. **Roster env override:** with `LEAGUE_CONFIG_LOCAL` set (and no local file present, as on Vercel), assert real manager names appear on the board and the placeholder names do not. With neither set, placeholders render.
2. **Token rotation:** change `COMMISSIONER_TOKEN` in Vercel env + redeploy; old token refused, new accepted.
3. **Polling load sanity:** 10 browser tabs polling `/api/state` for 10 minutes against production; no 5xx, no Neon connection exhaustion (postgres.js pool vs Neon free-tier connection limit - if exhausted, that's a bug to fix, e.g. pooled connection string).
4. **Fallback drill (timed):** kill venue-wifi assumption - laptop `npm start` against Neon; TV repointed; a sale recorded and propagated. Target: room back live in under 10 minutes. Then the cold-standby restore: `pg_dump` → local Postgres → app up read-correct.
5. **Freeze guard:** with `pool_frozen` set, `npm run ingest` refuses (already covered in `test-ingest`; re-verify against production DB before Jul 30).
6. **Draft-morning job dry run (Run 3+):** run valuations + briefs against a scratch DB with a real API key; assert every unsold player gets a valuation, values respect the league economy calibration, and the job's failure mode (no key / API down) leaves the app fully functional with panels hidden.
7. **Production recap smoke:** ✅ observed at `b9d1c5b`. `/api/recap` returned 200 and `/recap` rendered awards, war chests, final squads, FPL Draft checklists and the ledger link. Repeat after production reset/freeze.

## Historical baseline and current gate

On 8 Jul 2026, the then-current full battery ran on Windows 11, Node 24, against the production Neon instance before launch: schema 4, config 13, derive 19, state 7, draft 33+, concurrency 12×3, corrections 35, lot 62, ingest 6 and UI 23 all passed. `npm run build` exited 0. This is historical evidence only. DB-backed suites now run against a scratch database, never production.

At `b9d1c5b`, the integrated runner creates a throwaway scratch database, applies the schema, ingests the pool, resets to the exact post-ingest baseline before every suite, and drops the database at the end. Its 16 suites are: derive, club, schema, config, ingest, state, players, player detail, recap, draft, draft concurrency, corrections, trade, trades, lot and full night. The first 15 passed in the recorded #48/#50 run; the landed #58 commit adds the read-only trades suite and reports the full 16-suite battery green. This documentation refresh independently confirmed the runner composition and live read-only surfaces, but did not rerun the DB-backed battery.
