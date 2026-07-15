# Season economy - the wallet model (v2 proposal)

> Status: DRAFT, 9 Jul 2026. Proposed by the league owner; amounts and waiver
> mechanics not yet ratified by the group. **Nothing here changes v1 or the
> Aug 2 auction night.** This doc exists so v2 is designed against a written
> spec and so v1 code leaves the right seams open.
> Implementation note, 11 Jul: the two v1 seams below are landed in source. Sales and trades carry an additive `stage` tag, and `/recap` plus `season_recap` records the leftover August war chest. A production recap smoke passed on 11 Jul; ongoing runtime evidence belongs in issue #23. The broader wallet model remains a proposal.

## The idea in one line

Each manager has ONE wallet for the whole season. Money unspent at any stage
rolls forward into the next stage; cash injections top it up at fixed points.

## The four spending moments

| Stage | When | Money in | Money out | Balance after |
|---|---|---|---|---|
| Auction one | Aug 2 | A1 = $3,000 starting budget | X1 auction spend | Y1 = A1 - X1 |
| Waiver window one | Aug - Jan | A2 = $500 (TBC) injection | X2 waiver purchases | Y2 = Y1 + A2 - X2 |
| Auction two (rebid) | early Feb, after the real transfer window closes | A3 = $2,000 injection | X3 rebid spend | Y3 = Y2 + A3 - X3 |
| Waiver window two | Feb - May | A4 = $500 (TBC) injection | X4 waiver purchases | season ends |

All amounts are league config, never code.

## Retention at the rebid (the deliberate squeeze)

At auction two a manager may retain any player they own **at the price they
paid in August**. Everyone not retained goes back into the pool. **There is
no retention cap (decided 9 Jul): retain as many players as you can afford
from your February pot.**

The February injection is $2,000, not $3,000. Same retention price, smaller
pot: a $1,000 August star cost 33% of the August budget but eats 50% of the
February base pot. Effect: bargain buys and saved money appreciate; heavy
spending on one star is taxed at the rebid. This is intended.

## Waivers (mechanics TBD)

Between auctions, managers buy waivers to swap out injured or underperforming
players. Waiver spending draws on the same wallet, so it directly reduces
February firepower. **Direction (9 Jul): waivers run as mini auctions** -
contested players go to the highest bidder rather than a fixed fee or
priority order. Increments, timing, and what happens to a dropped player's
salary are still open with the group.

Banking money is an intended strategy, not an exploit (decided 9 Jul): a
manager who goes cheap in August and arrives rich in February has earned
that position. There is no carry-over cap.

## Open questions (decide before v2 build)

1. Injection amounts: $500 / $2,000 / $500 are working numbers; only the
   $2,000 rebid injection is considered settled.
2. Waiver mini-auction mechanics: opening price, increments, when and how
   the auction is held (live? deadline-based?).
3. Dropped player salary: gone entirely, or partial refund?
4. Rebid date: exact date in early February.
5. Roster shape between auctions: does 2 GK / 5 DEF / 5 MID / 3 FWD hold
   through waivers?

Resolved 9 Jul by the league owner: waivers are mini auctions (mechanics
above still open); no retention cap (retain whatever you can afford); no
carry-over cap (banking money is an intended reward).

## Consequences for the build

**v1 (Aug 2) is unchanged mechanically.** Two forward-compatible adjustments
landed before the auction:

1. **The recap headlines leftover money (Y1).** `/recap` shows each manager's
   live war chest and `scripts/archive-recap.mjs` snapshots it into
   `season_recap` as the end-of-night number of record.
2. **Money events carry a stage.** Sales and trades now have an additive,
   non-null `stage` column defaulting to `auction-1`. Future waiver and
   injection rows can use `waivers-1`, `auction-2` and `waivers-2` without
   untangling August's rows.

**v2 additions this model implies** (all fit the existing derive-from-ledger
rule: balances are never stored, always derived from the transaction log):

- New transaction types in the ledger: injection, waiver purchase, retention.
- Config gains a stages array: dates, injection amounts, waiver rules.
- Retention flow at rebid setup: pick keepers at August prices, releases
  return to the pool, budgets derive as Y2 + A3 - retained salaries.
- The max-bid reserve rule needs a February variant (open slots against the
  rebid pot, retained players excluded).
- The board's budget panel becomes stage-aware (shows current wallet, not
  "remaining of $3,000").
