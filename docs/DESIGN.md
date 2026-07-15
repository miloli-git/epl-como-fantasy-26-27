# Product Design - Auction v1

> Status: APPROVED. Matches `docs/PRD.md`. Low-fi wireframes here are structural only.
>
> **Visual design is now locked** - colors, type, and surface rules live in [`docs/VISUAL-DESIGN.md`](VISUAL-DESIGN.md), with a live sample at [`docs/wireframes/style-sketch.html`](wireframes/style-sketch.html).

## Surfaces (5, one responsive app, writes by token)

| Surface | Route | Audience | Mode |
|---|---|---|---|
| **Board ("On the block")** | `/` | the TV, and anyone's phone/laptop | read-only |
| **Reveal takeover** | (automatic on the board) | the room | read-only, fires on every sale |
| **Squads** | `/squads` | the room | read-only, all 8 squads on one screen |
| **Ledger** | `/ledger` | the room | read-only, every player / every price, search + sort + filter |
| **Console** | `/console` | the auctioneer | read + write (token) - the ONLY writer |

A sixth, post-auction page - **Recap** at `/recap` (awards, spend charts, the permanent record) - sits outside the live loop. All five live surfaces render from the same polled `/api/state` (~2s). There are no logins: this is a **war room** - one open URL for the TV, laptops, and phones, showing only publicly derivable numbers (budgets, max bids, squads, pool, sale log). The console selects what the TV shows (block / reveal / squads / ledger / paused).

## The auction-night flow (two phases)

```
PHASE 1 (every player offered once, price-desc, shuffled within tier)
  next lot from queue ──► PLAYER ON THE BLOCK  (broadcast to all surfaces)
            │                       │
            │                room bids verbally
            │                       │
            │        ┌── nobody bids ──► mark NO BID, stays available
            │        │
            │     auctioneer enters winner + $price
            │        │
            │        ▼
            │   POST /api/draft ──► validate ──► record sale ──► REVEAL takeover
            │        │                                (price vs sealed value + verdict)
            └────────┴──── board updates everywhere (~2s)
  repeat until every player has been offered once
            │
  auctioneer: "End phase one"  (explicit confirm step)
            ▼
PHASE 2 (nomination rotation)
  managers nominate any unsold player (including no-bids) in a FIXED
  ROTATION, skipping managers whose squads are full, until all squads
  are 15/15. Same bid/validate/record/reveal loop per nominated lot.
```

- **Phase 1 has no nomination** - lot order is FPL price descending, shuffled within tier. The console can see ~5 lots ahead; the room learns the next name only when the current lot closes. (An earlier draft of this doc said "no nomination phase" full stop - superseded: phase 2 IS nominated, in fixed rotation.)
- **Pause** is a first-class control: the auctioneer can pause for trades, discussion, or a break, and every surface shows a clear PAUSED state.
- **Trades are v1**: during a pause the auctioneer enters a two-sided trade (players and/or cash). Salaries travel with players; cash settles differences; guardrails enforce no negative budgets, quotas respected, squads <= 15. The board announces recorded trades.
- The auctioneer is the **single writer**, so there is no bid contention to resolve.
- **Player overlay on the block:** club-themed banner, official photo, last-season stats picked by role, overall + positional points rank, prior-season Como owner line (hidden if data absent), morning news brief, and a sealed-value chip (`CLAUDE VALUE - SEALED UNTIL THE HAMMER`).

## The max-bid rule (the one bit of real logic)

A manager's **max legal bid on the current lot** is position-aware and reserves the **minimum opening bid** (the lowest tier's open, $5 by default, config-driven - NOT $1) for each of their other open slots:

```
openSlotThisPosition = squad[pos] - filled[m][pos]        // must be > 0 to bid at all
otherOpenSlots       = (squadSize - slotsFilled[m]) - 1   // reserve minOpeningBid each
maxBid(m)            = openSlotThisPosition > 0
                         ? remaining[m] - max(0, otherOpenSlots) * minOpeningBid
                         : blocked                        // no slot for this position
```

So a manager with money but no empty GK slot **cannot** bid on a GK. When a manager has one slot left, their max = full remaining. This guarantees nobody can strand themselves unable to fill their squad. Computed server-side in `/api/state` for all 8 managers, shown on every surface, and **enforced at sale entry**.

## Validation (server, one transaction) - rejects a sale unless all hold

1. Player is the current lot (or the phase-2 nominated player) and is **not already sold** (exclusive ownership, DB constraint).
2. Winner has an **open slot for that position** and a free squad slot overall.
3. `price >= tier opening bid` and `price <= maxBid(winner)`.
4. Rejections explain themselves in plain words on the console (e.g. "Over M3's max bid of $1,190 - they must keep $5 per open slot").

## States and edge cases

- **Sold players** drop out of the pool; can't be re-offered (unless their sale is voided).
- **NO BID (phase 1):** cleared without a sale, marked in the lot history, remains nominatable in phase 2.
- **Blocked winners:** a manager who can't legally win the current lot is greyed in the console's winner picker, with the reason ("FWD full", "15/15").
- **Undo:** reverses the last sale, restoring budget + slot; the player returns to the pool. Audited.
- **Edit / void any sale:** from the ledger, with a reason; re-validated in the new state; audited with before/after.
- **Squad full:** excluded from the winner picker and skipped in the phase-2 rotation.
- **Late join / refresh / TV tab closed:** any surface catches up on its next poll; no per-client state.

## Low-fi wireframes

(Structural only; the real layouts are the approved visual designs. Numbers below assume the config defaults: $3,000 x 8 managers.)

### Board (TV)
```
┌────────────────────────────────────────────────────────────────────┐
│ ON THE BLOCK · LOT 14   HAALAND   FWD · MCI · TIER 1 · OPENS $50    │
│────────────────────────────────────────────────────────────────────│
│ [photo]  '25 pts + role stats     │ Recently sold:                  │
│ [club]   '25 Como owner line      │  ISAK → M5  $800                │
│          Morning brief (3 pts)    │ Pool by role x tier (bars)      │
│          🔒 CLAUDE VALUE - SEALED │ ⚠ scarcity alert                │
│────────────────────────────────────────────────────────────────────│
│ M1 $455 max $415 │ M2 $980 max $945 │ M3 $12 FULL │ M4 $305 ...     │
│ M5 $1,210 ...    │ M6 $60 ...       │ M7 $730 ... │ M8 $2,140 ...   │
└────────────────────────────────────────────────────────────────────┘
```

### Reveal takeover (fires automatically on every sale)
```
┌────────────────────────────────────────────────┐
│            HAALAND  →  M1                       │
│   PAID $780        │      CLAUDE VALUE $540     │
│        OVERPAY · +$240 - 44% OVER               │
└────────────────────────────────────────────────┘
```

### Console (auctioneer)
```
┌──────────────────────────────────────────────────┐
│ LOT 14 · HAALAND · T1 · FWD · MCI · opens $50     │
│ Winner: [M1 $415][M2 $945][M3 FULL][M4 ...] x8    │
│ Price: [ ___ ]  verdict: ✗ over M1's max ($415)   │
│ [ 🔨 RECORD SALE ] [ NO BID ] [ ⇄ TRADE ] [ ↩ ]   │
│──────────────────────────────────────────────────│
│ Up next (~5, hidden from room) │ Night progress   │
│ Phase: [ ⏹ End phase one ]  TV: [block▾]  [PAUSE] │
└──────────────────────────────────────────────────┘
```

## What this confirms for the build

- `/api/state` returns, per manager: `remaining`, `slotsFilled`, `byPosition`, and a **`maxBid`** computed against the on-block player - all derived at read time from sales + trades + config, never stored.
- A singleton `app_state` row holds phase, pause, current lot, TV view, nomination turn, lot queue, and a version counter that clients poll cheaply.
- Five surfaces off one component tree; console actions gated by `COMMISSIONER_TOKEN`.
- Sealed valuations are sealed **server-side**: never in a payload for an unsold player.

## Hosting (resolved)

- Vercel is the cloud primary. The verified laptop fallback is `npm run build` plus `npm start` against Postgres. Physical fallback drills remain pending.
