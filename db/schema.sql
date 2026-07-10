-- EPL Como Fantasy 26/27 - Postgres schema
-- Target shape per handoff 04-DATA-MODEL.md. Config (budget, squad, managers)
-- lives in league.config.json, NOT here, so the schema is season-agnostic.
--
-- ADDITIVE + IDEMPOTENT (#33). This file is safe to run against a live
-- database: it only ever CREATEs tables IF NOT EXISTS and ADDs columns IF NOT
-- EXISTS. It NEVER drops or recreates a table, so `npm run db:setup` can never
-- wipe a season of record once the production database holds real data.
--   - New tables: add a `create table if not exists ...` below.
--   - New columns: add them to the create below AND to the guarded migrations
--     block at the bottom (`alter table ... add column if not exists`), so
--     fresh and existing databases converge to the same shape.
-- (The original scaffold's drop-and-recreate of the old `picks` / `gw_scores`
-- and name-keyed managers/players was removed here: no production data was ever
-- in the target shape when it mattered, and a live db:setup must not drop.)

create table if not exists managers (
  id            serial primary key,
  slot          integer not null unique check (slot >= 1),  -- 1..8, config array order
  short         text not null,        -- "Manager 1".."Manager 8" in public seeds; real via local config
  display_order integer
);

-- Player pool, sourced from the FPL API (scripts/ingest-fpl.mjs).
create table if not exists players (
  id              integer primary key,   -- FPL element id (changes yearly - snapshot per season)
  code            integer,               -- stable PL code, drives photo URL p{code}.png
  web_name        text,
  first_name      text,
  second_name     text,
  team_id         integer,
  team_short      text,
  team_code       integer,               -- badge t{team_code}.png
  position        text check (position in ('GK','DEF','MID','FWD')),
  fpl_price       numeric(4,1),          -- now_cost / 10 (NOT the auction price)
  pts             integer,
  goals           integer,
  assists         integer,
  bonus           integer,
  starts          integer,
  minutes         integer,
  clean_sheets    integer,
  saves           integer,
  pens_missed     integer,
  yellows         integer,
  reds            integer,
  selected_by     numeric(4,1),
  tier            integer,               -- snapshotted at pool freeze from config bands
  age             integer,               -- best-effort, board bio strip
  nationality     text,
  height_cm       integer,
  prev_como_owner text,                  -- from the 2025 rosters (nullable)
  prev_como_price integer,
  overall_rank    integer,               -- computed at ingest
  position_rank   integer,               -- computed at ingest
  updated         timestamptz not null default now()
);

-- The draft log. One row per sold lot. Exclusive ownership is enforced by the
-- unique constraint on player_id (no multipick in EPL Como).
-- Undo/void = DELETE the row (audit row records it); UNIQUE(player_id) then
-- allows a later re-sale. Edits = UPDATE + audit row.
create table if not exists sales (
  id          serial primary key,
  player_id   integer not null unique references players(id),
  manager_id  integer not null references managers(id),
  price       integer not null check (price > 0),
  lot_no      integer,
  phase       integer check (phase in (1, 2)),
  stage       text not null default 'auction-1',  -- season-economy stage (#31): auction-1|waivers-1|auction-2|waivers-2
  created_at  timestamptz not null default now()
);

-- NO BID + offer history (drives phase-2 eligibility).
create table if not exists lot_events (
  id          serial primary key,
  player_id   integer references players(id),
  event       text check (event in ('offered','no_bid','nominated')),
  lot_no      integer,
  phase       integer,
  created_at  timestamptz not null default now()
);

-- Ownership after trades = sales JOIN latest trade movement (resolved in a
-- view/query layer; sale price travels through trades).
create table if not exists trades (
  id           serial primary key,
  manager_a    integer references managers(id),
  manager_b    integer references managers(id),
  cash_a_to_b  integer not null default 0,
  cash_b_to_a  integer not null default 0,
  stage        text not null default 'auction-1',  -- season-economy stage (#31), matches sales.stage
  created_at   timestamptz not null default now(),
  voided       boolean not null default false
);

create table if not exists trade_players (
  trade_id     integer references trades(id),
  player_id    integer references players(id),
  from_manager integer references managers(id),
  to_manager   integer references managers(id)
);

-- Sealed AI values. NEVER joined into any response for players without a
-- current sale.
create table if not exists valuations (
  player_id    integer primary key references players(id),
  value        integer,
  generated_at timestamptz
);

create table if not exists briefs (
  player_id integer primary key references players(id),
  bullets   jsonb,
  swept_at  timestamptz
);

create table if not exists audit_log (
  id         serial primary key,
  actor      text,
  action     text,       -- 'sale.create','sale.edit','sale.void','trade.create',...
  entity     text,
  entity_id  integer,
  before     jsonb,
  after      jsonb,
  reason     text,
  created_at timestamptz not null default now()
);

-- Singleton row (id = 1); bump version on every write so clients poll cheaply.
-- ALL auction mutations must go through withAuctionLock (lib/draft-core.mjs) -
-- the FOR UPDATE on this singleton serialises writes.
create table if not exists app_state (
  id                integer primary key check (id = 1),
  phase             integer not null default 1,
  paused            boolean not null default false,
  current_player_id integer,             -- on the block (null between lots)
  tv_view           text not null default 'block'
                    check (tv_view in ('block','reveal','squads','ledger','paused')),
  reveal_until      timestamptz,         -- when tv_view='reveal': expiry instant set by
                                         -- recordSale; NULL = persist until changed
                                         -- (what the console set_tv override writes)
  nomination_turn   integer,             -- manager slot whose nomination it is (phase 2)
  lot_queue         jsonb,               -- shuffled order (player ids), phase 1
  pool_frozen       boolean not null default false,
  version           bigint not null default 1
);

-- Idempotent migration for DBs created before reveal_until existed.
alter table app_state add column if not exists reveal_until timestamptz;

-- Season-economy stage tag (#31): every money event knows which stage it
-- belongs to (auction-1 | waivers-1 | auction-2 | waivers-2). Existing rows
-- backfill to auction-1 via the NOT NULL DEFAULT. No read derives on stage yet;
-- this is the forward-compatible seam so February never has to untangle
-- August's rows. See docs/SEASON-ECONOMY.md and issue #28.
alter table sales  add column if not exists stage text not null default 'auction-1';
alter table trades add column if not exists stage text not null default 'auction-1';

create index if not exists sales_manager_idx on sales(manager_id);
create index if not exists lot_events_player_idx on lot_events(player_id);
create index if not exists audit_log_created_idx on audit_log(created_at);
