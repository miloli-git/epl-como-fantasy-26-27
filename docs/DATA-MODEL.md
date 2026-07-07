# Data Model

> Status: APPROVED target shape. Canonical schema is `db/schema.sql`; this explains where it is headed. Note: the original scaffold's `picks` table is renamed **`sales`** (same exclusive-ownership idea, auction-night naming).

## Principles

- **Exclusive ownership is a DB constraint** (`sales.player_id` UNIQUE) - the final backstop against a double-sale, even under concurrent requests.
- **Derived values are never stored.** Spend, remaining, slot fills, and max bids are computed from sales + trades + config at read time. One source of truth, no sync bugs.
- **Sealed valuations never leave the server pre-sale.** The valuations table is only ever joined into API responses for players with a recorded, non-voided sale. Never ship sealed values to the client and hide them with CSS.

## Config layer (the reuse seam)

`league.config.json` holds everything that varies by season/sport: managers (placeholders in the committed file), budget, squad shape, tier bands / opening bids / increments, value-band thresholds, poll interval, reveal duration. A gitignored `league.config.local.json` overrides with the real roster; the two are deep-merged at **runtime**, not build time. Manager count and squad size always derive from config; nothing is hardcoded.

## Tables (target shape)

```
managers       id, slot (1..8, unique, maps to config array order), short ("M1".."M8"
               in public seeds; real names only via local config), display_order

players        id (FPL element id, snapshotted per season) PK, code (stable PL code,
               drives the photo asset), names, team id/short/code, position
               (GK|DEF|MID|FWD), fpl_price, last-season stats (pts, goals, assists,
               bonus, starts, minutes, clean sheets, saves, cards, ...), selected_by,
               tier (snapshotted at pool freeze from config bands), bio fields
               (age, nationality, height - best effort), prior Como owner + price
               (nullable; powers the "last season's owner" board line)

sales          id, player_id -> players (UNIQUE - the exclusive-ownership
               constraint), manager_id -> managers, price (> 0), lot_no,
               phase (1|2), created_at
               -- undo/void = DELETE the row (audit row records it); the UNIQUE
               -- constraint then allows a later re-sale. Edits = UPDATE + audit row.

lot_events     id, player_id, event (offered | no_bid | nominated), lot_no, phase,
               created_at   -- NO BID + offer history; drives phase-2 eligibility

trades         id, manager_a, manager_b, cash_a_to_b, cash_b_to_a, created_at, voided
trade_players  trade_id, player_id, from_manager, to_manager
               -- ownership after trades = sales JOIN latest trade movement; an
               -- ownership view resolves player -> current manager and the salary
               -- they carry (sale price travels through trades)

valuations     player_id PK, value, generated_at
               -- SEALED: never joined into any response for an unsold player

briefs         player_id PK, bullets (jsonb), swept_at   -- morning news briefs

audit_log      id, actor, action ('sale.create' | 'sale.edit' | 'sale.void' |
               'trade.create' | ...), entity, entity_id, before (jsonb),
               after (jsonb), reason, created_at

app_state      singleton row (id = 1): phase, paused, current_player_id,
               tv_view (block|reveal|squads|ledger|paused), nomination_turn,
               lot_queue (jsonb, shuffled phase-1 order), pool_frozen,
               version (bumped on every write; clients poll it cheaply)
```

## Derived at read time (views or query-layer functions)

- `spend(m)` = sum of sale prices of players currently owned by m (salary travels through trades) + net cash paid in trades.
- `remaining(m)` = budget - spend(m).
- `fills(m)` = counts by position of owned players; `open(m)` = 15 - total.
- `max_bid(m)` = `remaining(m) - min_open_bid x (open(m) - 1)`; blocked if no open slot for the current lot's position or squad complete. `min_open_bid` is the lowest tier's opening bid, from config.
- Pool counts by role x tier = players with no current owner, grouped.
- Value grading is relative to the live market, recalculated after every sale/void/edit.

## API surface

Reads (open, polled ~2s):

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/state` | one payload with everything the war room needs: app_state, current lot (player + brief + prior owner; NO valuation unless sold), recent sales, per-manager derived numbers (remaining, max bid, fills), pool role x tier counts, scarcity alerts, phase/rotation info, last-reveal payload, state version |
| GET | `/api/players?filter...` | the ledger data (valuations only on sold rows) |

Writes (require `Authorization: Bearer COMMISSIONER_TOKEN`):

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/draft` | record a sale `{playerId, managerId, price}` - THE critical endpoint. Validates: player is current lot (or phase-2 nominated), manager eligible, price >= tier open, price <= max bid. Inserts sale, advances lot, fires the reveal, bumps version. Must be concurrency-safe (transaction + row locks or serializable retry); UNIQUE(player_id) is the final backstop |
| DELETE | `/api/draft/latest` | undo last sale (audited) |
| PATCH | `/api/draft/:id` | edit any sale `{managerId?, price?, reason}`; re-validates in the new state; audited before/after |
| DELETE | `/api/draft/:id` | void any sale `{reason}` (audited) |
| POST | `/api/lot` | `{action}`: `no_bid`, `next`, `pause`, `resume`, `set_tv {view}`, `end_phase_one`, `nominate {playerId}` (validates rotation turn) |
| POST | `/api/trade` | two-sided trade payload; validates the full guardrail set (budgets >= 0 post-move, quotas, <= 15 each); audited; bumps version |
| POST | `/api/brief/:playerId` | on-demand news brief for lower-tier lots |

## FPL ingest

- Source: FPL `bootstrap-static` (`elements`, `teams`, `element_types`; position map 1=GK 2=DEF 3=MID 4=FWD; price = `now_cost / 10`).
- Tier computed from config bands at ingest and snapshotted.
- **Ingest guard:** once the pool is frozen or any sale exists, ingest refuses to change positions/tiers/ids (stats-only refresh at most). A mid-draft re-ingest corrupting quotas is the failure this prevents.
- Overall + positional points ranks computed at ingest.
- Player photos + club badges cached locally at freeze time - the venue's wifi must not be a dependency on the night.

## Draft-morning job

A re-runnable, idempotent script (or admin route) run on the morning of the auction: news sweep for top tiers into `briefs`, plus a valuation per player into `valuations` (generated by Claude, calibrated to the league economy). The board degrades gracefully if either table is empty - AI features never block the night.
