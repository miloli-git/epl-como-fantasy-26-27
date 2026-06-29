# Decisions to Confirm

> Status: OPEN. Everything below is either an assumption (from 25/26 actuals) or an unknown. `BLOCKER` = build can't proceed correctly without it. `DEFAULT` = I've assumed a sensible value; correct me or it stands.

## Resolved 2026-06-29

- **Scope:** v1 = the live **auction only**. Season scoring (the whole all-15-vs-weekly-XI/captain question, B1–B4) is **deferred** — out of v1.
- **Draft night:** in person → projector/big-screen board view **in v1**.
- **Repo:** public GitHub `github.com/miloli-git/epl-como-fantasy-26-27` (the miloli-git pattern), **MIT**. Auth via `gh` (no PAT needed).
- **Auction date:** **Aug 2, 2026** (~5 weeks runway from today).
- **Managers:** **8** (Organiser: "8 is the right number"); roster still being recruited.
- **Budget:** **$2000** (overrides Builder's "$200" note in the commissioner thread).
- **Season:** runs on the **official Draft FPL site**, not our app — all three agree. Our app is auction-only.
- **Nomination:** none. Lot order = FPL price descending (Como convention), with optional randomise-within-tier.
- **Pause:** yes. Commissioner can pause for trades, discussion, or a break.
- **Player-data overlay:** easy/factual FPL history on the lot (club, price, last-season points + starts). AI start-prediction is OUT (contested; research stays with bidders).

## Still open

- **Bidding model (the crux):** commissioner-enters-sold-price (no per-player auth, simplest) vs live per-player **login bidding** (Builder's notes: 30s bid timer, 10s reset, login so you only bid as yourself). This one decision drives auth, timers, and whether we need realtime infra. UNDECIDED.
- **Trades during the auction** (salary + players) — wanted by Organiser; net-new scope; depends partly on bidding model.
- **Formation-bound bids + pitch view** — in Builder's notes; not yet designed.
- **A1** — real 26/27 roster + names (count = 8 now set; kept out of the public repo, goes in local config). Confirm who.
- **A6 / Future** — rebid count + rule, when that phase starts.
- **C1** — when to freeze the player pool (FPL prices final in preseason).
- **D1** — commissioner identity (who drives on the night).
- **E4** — self-host route for the night (subdomain/reverse proxy).
- **E5** — porter's deploy: own Vercel + own DB (assumed).

## A. League format & rules

| # | Item | Current assumption | Status |
|---|---|---|---|
| A1 | 26/27 manager list (real names + count) | 7, the 25/26 crew | BLOCKER (config seed; count drives the app) |
| A2 | Budget per manager | $2000 | DEFAULT |
| A3 | Squad composition | 2 GK / 5 DEF / 5 MID / 3 FWD (15) | DEFAULT |
| A4 | Bid floor / increment | $1 floor, no fixed increment | DEFAULT |
| A5 | Ownership | exclusive, no multipick | DEFAULT (confirmed vs WC) |
| A6 | Rebid rounds | 3, deferred from v1 build | confirm intent only |
| A7 | In-season transfers/free agents beyond rebids | none | confirm |

## B. Scoring — the biggest real unknown

| # | Item | Why it matters | Status |
|---|---|---|---|
| B1 | **Do all 15 owned players score every GW, or do you set a weekly starting XI?** | If there's a weekly XI, the app needs lineup-setting + formation rules + bench. If all 15 always count, Phase 2 is a simple sum. Completely different builds. | BLOCKER |
| B2 | Captain / vice multiplier? | FPL doubles a captain. Does Como? Changes scoring + needs a per-GW captain pick UI. | BLOCKER (with B1) |
| B3 | Bench / autosubs? | Only relevant if B1 = weekly XI. | depends on B1 |
| B4 | Chips (wildcard/triple-captain/etc.)? | Probably no; confirm none. | confirm |
| B5 | Season start GW + any mid-season join handling | GW1 2026/27 | DEFAULT |

## C. Data / FPL pool

| # | Item | Note | Status |
|---|---|---|---|
| C1 | When do we lock the player pool? | FPL prices/squads aren't final until preseason; element IDs change yearly. Ingest is cheap to re-run, but the *draft* needs a frozen pool. | confirm timing |
| C2 | Pool source of truth | FPL `bootstrap-static` (4 element_types, verified) | DEFAULT |
| C3 | Promoted clubs / new signings present in FPL by draft date | usually yes by August | flag |

## D. App / UX

| # | Item | Current assumption | Status |
|---|---|---|---|
| D1 | Commissioner identity | one operator, token-gated | confirm who |
| D2 | Manager view auth | open via link, read-only | DEFAULT (public-ish; ok?) |
| D3 | Big-screen / projector view for draft night | not in v1 | confirm want/not |
| D4 | Draft night: in-person or remote? | affects whether phones+projector or pure remote | BLOCKER-ish for UX |
| D5 | Undo/edit a mis-entered sale | yes (`DELETE /api/draft`) | DEFAULT |
| D6 | Device target | mobile-first | DEFAULT |

## E. Infra / deploy / repo

| # | Item | Current assumption | Status |
|---|---|---|---|
| E1 | GitLab namespace + repo name + public | `epl-como-fantasy-26-27`, public | BLOCKER (need your auth) |
| E2 | Open-source license | MIT (matches reference libs) | confirm |
| E3 | Reference Postgres | Neon free tier | DEFAULT |
| E4 | NAS hosting route for draft night (subdomain/Cloudflare) | TBD | confirm |
| E5 | Porter's deploy: own Vercel + own DB, or shared DB? | own | confirm |
| E6 | Real-name privacy: placeholder config + gitignored local roster | as built | confirm ok |

## F. Process & timeline

| # | Item | Current assumption | Status |
|---|---|---|---|
| F1 | 26/27 draft date | preseason, ~Aug 2026 | drives urgency — confirm |
| F2 | v1 scope freeze (draft + standings; rebids later) | as in PRD | confirm |
| F3 | `/api/draft` built via /dual-harness (correctness-critical) | yes | confirm |
| F4 | Adopt the "before any public push" scrub gate | yes | confirm |

## Top blockers to clear first
1. **B1/B2** — weekly starting XI + captain, or all-15-sum? (defines Phase 2 entirely)
2. **A1** — real 26/27 roster + count.
3. **D4** — draft night in-person or remote?
4. **E1** — GitLab auth so the repo can exist.
5. **F1** — draft date, so we know the runway.
