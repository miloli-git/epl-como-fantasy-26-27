# Prior Art - Auction-Draft FPL League App

External/public research only. Compiled 2026-06-29. Every claim links a source. Items I could not verify as of today are flagged.

## Summary (BLUF)

- **Build-our-own call stands.** No open-source or commercial product does the specific combo we need: a **commissioner-run live auction room** + a **read-only phone board for all managers** + an **FPL-points season tracker** wired to one private league. The pieces exist in scattered repos, but none is a drop-in, and none is a maintained Next.js/Postgres stack worth forking wholesale.
- **Adopt one library, not a framework:** use **`fpl-api`** (jeppe-smith, TypeScript, MIT) as a typed reference for the FPL endpoints, or just hand-roll thin `fetch` wrappers - the endpoints are trivial. Do **not** add the Python `amosbastian/fpl` lib (wrong language for our stack, async-only). See FPL API facts below; our ingest is low-risk.
- **The type-5 "Manager" worry is resolved:** the live `bootstrap-static` today exposes **exactly 4 `element_types`** (GKP/DEF/MID/FWD). The "Assistant Manager" was a **2024-25-only chip**, implemented as a separate `managers` structure (never `element_type: 5`), and was **scrapped for 2025-26**. Still, defensively filter `element_type > 4` to be safe against future re-adds. [Source](https://www.premierleague.com/en/news/4373187/whats-new-for-202526-changes-in-fantasy-premier-league)
- **Real-time:** for a single private league (≤~16 viewers, commissioner is sole writer), **client polling every 2-3s against a Postgres-backed read endpoint is the right answer** on Vercel. Don't reach for Pusher/Ably/Supabase Realtime - they solve a scale/frequency problem we don't have, and SSE is awkward on Vercel serverless (timeouts). Keep the polling design.
- **Two repos worth a 20-minute read** before building the auction room: **`anacronw/fantasy-auction`** (admin nominates → managers bid → big-screen "general" view; the exact three-role model we want, though C#/WebSockets) and **`RvI101/Fantasy-Football-Auction-Web-App`** (FPL-sourced players, league/invite flow; but it's *blind-bid*, not live-bid). Borrow the role/screen model, not the code.

## Open-source projects

| Name | Link | Stack | License | Last updated | Reuse verdict |
|------|------|-------|---------|--------------|---------------|
| **fpl-api** (jeppe-smith) | [github](https://github.com/jeppe-smith/fpl-api) · [npm](https://www.npmjs.com/package/fpl-api) | TypeScript, browser+Node | MIT | Looks **stale** (no recent releases; ~17★, low npm DL) | **Reference / light adopt.** Typed `fetchBootstrap`/`fetchLive`/`fetchFixtures` etc. matching our needs. Vendor or copy types; don't depend on it long-term given low maintenance. |
| **amosbastian/fpl** | [github](https://github.com/amosbastian/fpl) · [docs](https://fpl.readthedocs.io/) | **Python** (async) | MIT | Active-ish (~327★, 623 commits) | **Reference only.** Wrong language for Next.js; async wrapper adds nothing we need. Good as a schema/endpoint cheat-sheet. |
| **anacronw/fantasy-auction** | [github](https://github.com/anacronw/fantasy-auction) | C#, JS, **WebSockets** | MIT | **Inactive** (9 commits, 2★) | **Study, don't fork.** Implements the exact 3-role live-auction UX: `/admin` nominates, `/manager` bids, big-screen `/general` view. Mine the interaction model. |
| **RvI101/Fantasy-Football-Auction-Web-App** ("GALE") | [github](https://github.com/RvI101/Fantasy-Football-Auction-Web-App) | Angular + TS, Firebase | Not stated (treat as all-rights-reserved) | Unknown (33 commits, no dates shown) | **Study, don't fork.** League + invite + FPL-sourced players is on-point, but it's **blind-bid** (batch resolve), not the live commissioner auction we're building. Different mechanic. |
| **mattheworres/hootdraft** | [github](https://github.com/mattheworres/hootdraft) | PHP 7.1+, MySQL | (see repo) | Mature but **legacy stack** | **Reference for the live board only.** Big color-coded board built for projectors, live pick updates, multi-sport. Snake/pick draft, **not auction**. Good UI inspiration for the read-only board. |
| **bapairaew/open-fpl** | [github](https://github.com/bapairaew/open-fpl) | **Next.js**, Vercel, Chakra, TS | Not specified | **Stale** (latest release 1.3.0, Feb 2022) | **Reference for FPL data layer.** Has `data/*` pull+process scripts against bootstrap-static/Understat. Useful pattern for our ingest; app itself is a stats/planner tool, no auction or draft. |
| **djstozza/fpl_app** | [github](https://github.com/djstozza/fpl_app) | Ruby on Rails + React/Redux | (see repo) | Unknown | **Low value.** Snake draft for FPL Draft, not auction; stack mismatch. |
| **C-Roensholt/fpl-api**, **roboflank/fpl-ts**, **pmc-a/fpl-fetch** | [fpl-ts](https://github.com/roboflank/fpl-ts) · [fpl-fetch](https://github.com/pmc-a/fpl-fetch) | TS wrappers | MIT (typ.) | Mixed/small | **Alternatives to fpl-api** if it's too stale. `fpl-fetch` markets itself as "modern, type-safe." Quick swap candidates; verify maintenance before adopting. |

Notes:
- "Last updated" precision is limited - GitHub's rendered pages don't always expose commit timestamps to the fetcher. Where I wrote "stale/inactive" it's inferred from release dates and commit counts; **verify the latest-commit date on the repo page before committing to any dependency.**
- No project found that pairs a **live auction room** with an **FPL-points season tracker**. That integration is genuinely ours to build.

## FPL API - current facts (verified against the live API today, 2026-06-29)

- **Base:** `https://fantasy.premierleague.com/api/` - no official docs; community-documented. [Frenzel guide](https://medium.com/@frenzelts/fantasy-premier-league-api-endpoints-a-detailed-guide-acbd5598eb19) · [Oliver Looney](https://www.oliverlooney.com/blogs/FPL-APIs-Explained)
- **`GET /bootstrap-static/`** - core dump: `elements` (players), `teams`, `events` (gameweeks), `element_types`. Verified live: **`element_types` has exactly 4 entries** - id 1 `GKP` Goalkeeper, 2 `DEF` Defender, 3 `MID` Midfielder, 4 `FWD` Forward. **No id 5 / "Manager" / "Assistant Manager" element type exists today.**
- **The Manager/type-5 question, answered:** the "Assistant Manager" was a **chip introduced GW24 of 2024-25 only**, surfaced as a separate `managers` object - it was **never** a 5th `element_type` in `bootstrap-static`. FPL **scrapped it for 2025-26** after negative survey feedback, replacing it with two half-season chip sets. So as of 2026 there is nothing to filter. [Premier League official](https://www.premierleague.com/en/news/4373187/whats-new-for-202526-changes-in-fantasy-premier-league) · [Fantasy Football Hub](https://www.fantasyfootballhub.co.uk/fpl-chips-2025-26-announced) Defensive recommendation: still guard with `element_type in (1,2,3,4)` in ingest, in case a future season re-adds a non-player element.
- **`now_cost` units:** integer in **tenths of a million**, divide by 10 for display (verified: David Raya `now_cost: 62` = £6.2m; `ui_currency_multiplier: 10` in `game_settings`). For an auction app these are FPL list prices - likely cosmetic only, since your league sets its own auction budget.
- **Per-gameweek points:**
  - `GET /event/{event_id}/live/` → all players for that GW; each element has `stats` (incl. **`stats.total_points`**) and an `explain` breakdown. **This is the endpoint to drive the season tracker** - pull each finished GW once, map points to owned players. [Frenzel guide](https://medium.com/@frenzelts/fantasy-premier-league-api-endpoints-a-detailed-guide-acbd5598eb19)
  - `GET /element-summary/{element_id}/` → per-player `history` (per-fixture/GW points), `fixtures`, `history_past`. Useful for backfill/per-player views.
  - GW finalisation: `events[].finished` / `data_checked` flags in bootstrap tell you when a GW's points are safe to ingest.
- **Player identity for ownership mapping:** `elements[].id` is the stable player id; map your auction lots to this id. (FPL re-numbers some ids season to season - re-resolve at season setup.)
- **Note:** all the above are **public, unauthenticated** endpoints. Auth'd endpoints (`/my-team/{id}/`, `/me/`) are not needed for our use case.

## Commercial / SaaS

- **Official FPL Draft** (`draft.premierleague.com`) - free, but it's a **snake draft + waivers**, *not auction*, and runs its own scoring/roster system you can't repoint at a private auction league. API exists (`/api/league/{id}/details`) but it doesn't solve auction. **Does not replace build.** [Frenzel guide](https://medium.com/@frenzelts/fantasy-premier-league-api-endpoints-a-detailed-guide-acbd5598eb19)
- **FanDraft** ([fandraft.com/auctiondrafts](https://fandraft.com/auctiondrafts)) - commercial draft-board software with an auction-draft mode (NFL-centric), built for in-room big-screen drafts. Good UX reference for the auction board, but **no FPL/EPL data, no season tracker, paid, closed-source.** Not a fit.
- **ESPN / Yahoo / Sleeper** auction drafts - mature auction UIs for US sports, but closed, no EPL/FPL, no custom league import. Reference for interaction patterns only.
- Net: **no SaaS replaces the build.** The differentiator - private EPL league, auction mechanic, FPL-points-driven standings - isn't sold anywhere I could find.

## Real-time patterns (2026)

For a single commissioner-writes / many-read live board on Vercel:
- **Vercel's own guidance:** serverless functions can't hold persistent sockets (execution timeouts), so the platform recommends client-subscribes / function-publishes, and lists hosted realtime partners (Ably, Pusher, Supabase, Convex, Liveblocks, Partykit, etc.). [Vercel KB](https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel)
- **SSE on Vercel is awkward** - works but fights function timeouts; long-lived streams are a known pain. [next.js discussion #48427](https://github.com/vercel/next.js/discussions/48427)
- **Hosted realtime (Pusher/Ably) is overkill here.** Pusher's edge is >15-20 updates/sec; an auction has one writer making a bid every several seconds. [Ably write-up](https://ably.com/blog/next-js-vercel-link-sharing-serverless-websockets)
- **Recommendation: keep polling.** A `GET /api/draft/state` reading current Postgres state, polled every 2-3s by each phone (SWR/`useSWR` with `refreshInterval`, or a bare `setInterval`), is simplest, cheapest, serverless-native, and more than fast enough for an auction cadence. This is the same fetch-on-demand pattern Vercel's own dashboard uses (SWR). [Vercel KB](https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel) Optionally add a lightweight `version`/`updated_at` field so clients can short-circuit no-op renders.

## Recommendation

1. **Build our own - confirmed.** No fork shortcut exists for the auction-room + FPL-tracker combo.
2. **FPL ingest:** hand-roll thin typed `fetch` wrappers (or vendor `fpl-api`'s types). Endpoints to use: `bootstrap-static` (players/teams/types), `event/{id}/live` (GW points → tracker), `element-summary/{id}` (backfill). Guard `element_type in (1..4)`, divide `now_cost` by 10. Ingest is **low-risk** - verified live today.
3. **Auction room:** before coding, read `anacronw/fantasy-auction` for the admin/manager/big-screen role split and `hootdraft` for the live-board UI. Implement bids as Postgres writes by the commissioner only; validate budget + roster-slot + exclusive-ownership server-side.
4. **Real-time:** keep the planned polling design; skip Pusher/Ably/Supabase Realtime.
5. **Don't adopt as a dependency:** any of the auction repos (stack mismatch / inactivity / unclear license). Treat them as reference, not code.

### Flagged / unverified
- Exact latest-commit dates for several repos couldn't be read off the rendered GitHub pages - **check the repo's commit timestamp before taking any dependency.**
- `fpl-api` (jeppe-smith) maintenance is uncertain; if its types lag the 2026-27 season schema, switch to `pmc-a/fpl-fetch` or copy types from `amosbastian/fpl`. Verify against a live `bootstrap-static` pull at season setup.
- License for `RvI101/Fantasy-Football-Auction-Web-App` and a couple of others was not stated - assume all-rights-reserved; reference behaviour only, do not copy code.
