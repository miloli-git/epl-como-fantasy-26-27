# Reset and test-run runbook (developer / dress-rehearsal)

> For standing up a throwaway copy of the auction, driving it end to end, and
> wiping it back to clean so you can test again. This is the DEV loop, not the
> auction-night runbook - for the night see `docs/RUNBOOK.md`, `docs/PREFLIGHT.md`,
> and `docs/AUCTIONEER-CHEATSHEET.md`.
>
> Every command below was run against a throwaway scratch database before this
> doc was written. Commands are PowerShell (the build machine's shell).

## The golden rule

**Never run a write command against the two shared databases.** They are:

| Database | How the app reaches it | What it is | Treat as |
|---|---|---|---|
| `neondb` | `.env` (`DATABASE_URL`) | the main Neon database | read-only unless you decide otherwise |
| `como_demo` | `.env.local` (`DATABASE_URL`) | the demo auction (a lifelike mock, real initials on screen) | read-only unless you decide otherwise |

All setup, seeding, driving, and wiping below happens on a **separate scratch
database** you create beside them on the same Neon instance. If a command takes
a database, point it at your scratch env file, never at `.env` or `.env.local`.

> Note: the local helper scripts used below (`_scratch-db.mjs`, `_seed_*.mjs`,
> `_mkdemo.mjs`, `_reset-auction.mjs`) are gitignored (`/_*.mjs`) - they live in
> this working copy only, not in a fresh clone or on the fallback laptop.

## 1. Create a scratch database (once per test session)

`_scratch-db.mjs` connects using `.env` (neondb) only as the maintenance login,
creates a brand-new database beside it, and writes you a scratch env file. It
never writes to neondb or como_demo.

```powershell
# creates database "como_scratch" and writes .env.scratch.local (gitignored)
node --env-file=.env _scratch-db.mjs create como_scratch .env.scratch.local
```

`.env.scratch.local` now holds the scratch `DATABASE_URL` and
`COMMISSIONER_TOKEN=scratch-token`. Use `.env.scratch.local` (matches the
`.env*.local` ignore) - do NOT name it `.env.scratch` (that is not gitignored).

## 2. Populate it (schema, players, freeze)

The `npm run` shortcuts do not pass an env file, so drive the scripts directly
with `--env-file` pointed at your scratch env. This is what guarantees you are
not touching a shared database.

```powershell
node --env-file=.env.scratch.local scripts/db-setup.mjs          # schema + 8 managers + app_state
node --env-file=.env.scratch.local scripts/ingest-fpl.mjs        # ~840 players from the FPL API, tiered
node --env-file=.env.scratch.local scripts/ingest-fpl.mjs --freeze  # locks the pool (pool_frozen = true)
```

Expected: `seeded 8 managers`, then `ingested <N> players from FPL`, then
`pool frozen: app_state.pool_frozen = true`. After the freeze, a full re-ingest
refuses (`INGEST REFUSED: the pool is locked ...`); `--stats-only` still works.

> The scratch database is seeded with the **real roster** when
> `league.config.local.json` is present (it is, on the build machine), so it
> shows real names. Treat it like como_demo: keep it local, never screenshot
> or post it.

## 3. (Optional) seed a lifelike auction

To get a board and console full of life immediately (instead of an empty pool),
run the demo seeders against your scratch env:

```powershell
node --env-file=.env.scratch.local _seed_auction.mjs     # ~23 sales, a few no-bids, 2 trades, a marquee on the block
node --env-file=.env.scratch.local _seed_spotlight.mjs   # prior-season owner line + morning briefs
```

Sealed valuations: `_seed_valuations.mjs` is guarded to `como_demo` only and
will refuse a scratch database. On a scratch DB the sealed-value / reveal panels
simply stay hidden (the auction still runs). To exercise the reveal value on a
scratch DB, run the real morning job `scripts/generate-valuations.mjs` (needs
the Anthropic key), or just eyeball the reveal on como_demo read-only.

## 4. Run the app against the scratch database and drive it

`next dev` reads `.env.local` (como_demo) by default, so to point it at your
scratch DB set the two variables in the shell first - a value already in the
environment wins over the `.env` files.

```powershell
# paste the DATABASE_URL value from .env.scratch.local between the quotes:
$env:DATABASE_URL = "postgresql://...your scratch url.../como_scratch?sslmode=require"
$env:COMMISSIONER_TOKEN = "scratch-token"
npm run dev
```

Then, in a browser:

1. Open `http://localhost:3000/api/state` and confirm the on-block player and
   sale count match your scratch data (not the demo). This is your proof you are
   driving the scratch DB, not como_demo.
2. Open `http://localhost:3000/console`, paste `scratch-token` into the token
   box at the top. The strip should show a green live dot.
3. Record a sale (pick a manager, enter a price, Record). The board updates
   within ~2s and the reveal fires. Undo last, No-bid, Trade, End phase one, and
   the TV-view switcher all work from here.

If you started from an **empty** frozen pool (section 2 only, no section 3),
there is no lot on the block yet and the console has no build-queue button.
Build the queue once, either by running `_seed_auction.mjs`, or directly:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/lot `
  -Headers @{ Authorization = 'Bearer scratch-token' } `
  -ContentType 'application/json' -Body '{"action":"build_queue"}'
```

That shuffles the pool and puts lot 1 on the block.

## 5. Wipe back to a clean state (to test again)

Two ways, depending on whether you want to keep the ingested pool.

**A. Fast reset - keep the frozen player pool, clear the auction.** Clears every
sale, trade, and lot event and resets the `app_state` singleton, but keeps the
~840-player frozen pool and the managers (no re-ingest needed):

```powershell
node --env-file=.env.scratch.local _reset-auction.mjs
```

Expected: `reset done: 0 sales, phase=1, on_block=null, pool_frozen=true, queue=null`.
Then rebuild the queue (the `build_queue` call above) or re-run `_seed_auction.mjs`.

The raw SQL that helper runs, if you ever want it by hand (FK-safe order, one
transaction) - run against a scratch or demo DB only, never production:

```sql
begin;
delete from trade_players;
delete from trades;
delete from sales;
delete from lot_events;
update app_state set
  phase = 1, paused = false, current_player_id = null,
  tv_view = 'block', reveal_until = null, nomination_turn = null,
  lot_queue = null, version = version + 1
where id = 1;
commit;
```

**B. From absolute scratch - throw the database away and rebuild.** Guaranteed
clean; slower (re-ingests):

```powershell
node --env-file=.env _scratch-db.mjs drop como_scratch
node --env-file=.env _scratch-db.mjs create como_scratch .env.scratch.local
node --env-file=.env.scratch.local scripts/db-setup.mjs
node --env-file=.env.scratch.local scripts/ingest-fpl.mjs
node --env-file=.env.scratch.local scripts/ingest-fpl.mjs --freeze
```

Note: re-running `db:setup` alone is NOT a wipe - the schema is create-if-not-exists,
so it re-seeds managers and leaves existing sales in place. Use A or B to clear data.

## 6. Full automated battery (the pre-cutover gate)

Independent of the scratch DB above, the battery self-provisions its own
throwaway database (`como_test_battery`), runs every suite, and drops it. It
never touches neondb or como_demo:

```powershell
node --env-file=.env scripts/test-all.mjs
```

Confirm the summary is all PASS and it exits cleanly.

## 7. Tear down

```powershell
node --env-file=.env _scratch-db.mjs drop como_scratch
Remove-Item .env.scratch.local
```

Dropping the scratch database also removes the real names it was seeded with, so
nothing lingers on the Neon instance.

## Quick reference

| Goal | Command (PowerShell) |
|---|---|
| Make scratch DB | `node --env-file=.env _scratch-db.mjs create como_scratch .env.scratch.local` |
| Schema + managers | `node --env-file=.env.scratch.local scripts/db-setup.mjs` |
| Load players | `node --env-file=.env.scratch.local scripts/ingest-fpl.mjs` |
| Freeze pool | `node --env-file=.env.scratch.local scripts/ingest-fpl.mjs --freeze` |
| Seed a live auction | `node --env-file=.env.scratch.local _seed_auction.mjs` |
| Run app on scratch | set `$env:DATABASE_URL` + `$env:COMMISSIONER_TOKEN`, then `npm run dev` |
| Wipe (keep pool) | `node --env-file=.env.scratch.local _reset-auction.mjs` |
| Full battery | `node --env-file=.env scripts/test-all.mjs` |
| Drop scratch DB | `node --env-file=.env _scratch-db.mjs drop como_scratch` |
