# Pre-Wednesday Discovery - decisions to lock

> **HISTORICAL - kept for the record only.** Every question below has since been decided; the decisions live in `docs/DECISIONS-TO-CONFIRM.md` (the closed decision table), and the requirements of record are `docs/PRD.md` / `docs/DESIGN.md` / `docs/DATA-MODEL.md`. Do not treat anything below as current.

> The "list of qs" to work through before the Wed session, so the meeting is for deciding, not discovering. Built from Builder's auction notes + the commissioner thread + the design so far. **CONFIRMED** = agreed, ratify with the group. **OPEN** = decide. Each open item has options + a lean.
>
> v1 is the **auction only**. The season runs on the official Draft FPL site (all agreed). Anything season-side (scoring, waivers, keepers, FAAB) is captured at the bottom for completeness but is out of the build.

## 1. Auction format (mostly CONFIRMED - ratify)

1.1 **Managers: 8.** CONFIRMED. → Open sub-q: who are the 8? (roster still being recruited)
1.2 **Budget: $2000 each.** CONFIRMED (supersedes the "$200" note).
1.3 **Squad: 15** - 2 GK / 5 DEF / 5 MID / 3 FWD. CONFIRMED.
1.4 **Ownership: exclusive** (one manager per player, no multipick). CONFIRMED.
1.5 **Min bid: $1.** CONFIRMED.
1.6 **Max bid = remaining budget − $1 per other empty slot**, and only if you have an open slot for that position. CONFIRMED (Builder's notes match the design exactly).

## 2. Lot order (CONFIRMED)

2.1 **No nomination phase.** Players come up in **FPL price order, most expensive first** (Como convention).
2.2 **Randomise within tier?** Sometimes done historically. OPEN: always price-order, or shuffle within each price tier? Lean: support both, commissioner toggles per session.

## 3. Bidding model - THE CRUX (OPEN)

The one decision everything else hangs off. Two coherent options:

- **A) Commissioner-entry (verbal room bidding).** Room bids out loud; commissioner records winner + price. No per-player login, no timers, no realtime infra. Simplest to build and rock-solid for an in-person auction. *Lean for a v1 shipping by Aug 2.*
- **B) Live login bidding.** Each manager logs in and places their own bids in-app, with timers (Builder's notes: 30s bid timer, 10s reset per bid). Needs per-player auth, realtime updates, and handles disconnects/contention. Much bigger build; closer to a "real" auction app.

→ **Decide A or B.** If B, then 3.x below all apply; if A, most of them disappear.
3.1 (B only) Bid timer length (notes: 30s) and reset-on-bid (notes: 10s)?
3.2 (B only) Login method - how do 8 people authenticate simply?
3.3 (B only) What happens on disconnect / missed timer?

## 4. Pause (CONFIRMED yes - detail OPEN)

4.1 Pause is wanted for trades, discussion, breaks. CONFIRMED.
4.2 OPEN: per-manager pause allowance (notes: 2 each × 1 min) + unlimited commissioner pause - adopt as-is, or simpler "commissioner pauses on request"? Lean: commissioner-controlled pause for v1; formal per-manager allowance only if bidding is timed (model B).

## 5. Trades during the auction (OPEN - scope)

5.1 Organiser wants in-auction trades: swap players and/or salary, and "offer money for ongoing auction." OPEN: in scope for v1, or fast-follow? Lean: **fast-follow** - it adds real complexity (multi-party offers, salary accounting mid-draft) and risks the Aug 2 date. Capture the rules now, build after.

## 6. Formation & pitch view (OPEN)

6.1 "Players must bid with formation" + a pitch view. OPEN: is a formation/pitch view needed *during* the auction, or only once squads are set / on the official site? Lean: squads are just slot counts during the auction (our board already shows G/D/M/F fill); a pitch view is nice-to-have, not v1-critical.

## 7. Player-data overlay (CONFIRMED scope)

7.1 Show **easy/factual FPL history** on the lot: club, position, price, last-season points, last-season starts/minutes, ownership. CONFIRMED (in the wireframes).
7.2 **No AI "chance of starting" / injury-prediction.** CONFIRMED - research stays with each bidder (Advisor's position; Organiser dissents, flag for group). OPEN if the group overrides: would only ever be a factual injury *status* flag, never a model.

## 8. Logistics (OPEN)

8.1 Where does it run on the night? (self-host vs a shared URL for the room)
8.2 Official Draft FPL league launches ~end July - does that gate anything (player IDs/prices final)?
8.3 Auction date Aug 2 - firm?

## Season-side - OUT of the build, captured for the group

These run on the official Draft FPL site, but the group should still agree them:
- **Scoring:** draft.premierleague scoring (confirm).
- **Rebids:** how many? (notes imply ≥1) - and salaries are **kept** across rebids (price paid reduces next budget).
- **Keepers:** ~5 retained for the season (confirm number).
- **FAAB:** $100 season waiver budget; **waivers reset 1 day after the last game of the gameweek.**
- **Waiver system:** official Draft FPL waivers, or our own rules?
