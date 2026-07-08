# Pre-flight checklist - from freeze to first bid

> The tick-list that turns "it should work" into "it works". Run it in order. Each item says how to know it passed.
> Companion docs: `docs/AUCTIONEER-CHEATSHEET.md` (running the night), `docs/RUNBOOK.md` (recovery if something breaks), `docs/DEPLOYMENT.md` (the platform decisions behind these steps).

Nothing here needs coding knowledge. Where a step is a command, it is copy-paste from a laptop that has the repo and `npm install` already done.

## Two days before - pool freeze (Jul 30-31)

- [ ] **Final data pull.** From the laptop, with `.env` pointing at the production database: `npm run ingest`. Confirm it reports the full player pool loaded (hundreds of players).
- [ ] **Freeze the pool.** From the laptop, with `.env` pointing at the production database: `node --env-file=.env scripts/ingest-fpl.mjs --freeze`. It confirms with "pool frozen: app_state.pool_frozen = true". After this, no full ingest runs until the auction is over.
- [ ] **Verify the freeze holds.** Run `npm run ingest` once more and confirm it *refuses* with a message starting "INGEST REFUSED: the pool is locked". If it still runs, stop and fix before proceeding - a late ingest could reshuffle the pool. (Stat-only refreshes via `npm run ingest:stats` stay allowed and safe.)
- [ ] **Roster is real.** Open the live board; confirm the eight real manager names show (not "Manager 1..8"). If placeholders show, the `LEAGUE_CONFIG_LOCAL` env var on the host is missing or wrong.

## Draft morning (Aug 2, a few hours before)

- [ ] **Run the valuations + briefs job.** From the laptop with the Anthropic key set, against the production database:
  `node --env-file=.env scripts/generate-valuations.mjs` (see the script's own header for the exact flags). This writes the sealed AI values and news briefs for the day.
- [ ] **Confirm it finished cleanly.** It should report a value for every unsold player. If it fails or the key is missing, that is OK - the auction runs fine, the value panels simply stay hidden. Do not block the day on it.
- [ ] **Sealed values stay sealed.** Open the live board as a normal viewer. You must NOT see any AI valuation for a player who has not been sold. (The reveal only appears at the hammer.) If a value leaks pre-sale, stop and raise it - that is a real bug.
- [ ] **Full test battery, one last time.** From the laptop: `node --env-file=.env scripts/test-all.mjs`. This runs everything against a throwaway scratch database and drops it; it never touches production. Confirm the summary is all PASS and it exits cleanly.

## One hour before - in the room

- [ ] **TV is up and on the board.** Open the live URL on the TV (or the device driving it). Set the bottom TV bar to **block**. Confirm the board fills the 77-inch screen cleanly and is readable from the back of the room.
- [ ] **Light or dark.** Decide the board theme on the actual TV in the actual room light (this is the moment that decision gets made). Set it and leave it.
- [ ] **Auctioneer device works.** On the auctioneer's device, open the console URL. Paste the commissioner token. Confirm the top strip shows a green **BOARD LIVE** dot.
- [ ] **One real test sale, end to end.** With a human watching the TV: record a test sale on the console, confirm the board updates within about two seconds and the reveal fires, then press **Undo last**. Confirm the board returns to normal. This is the single most important check - a server responding is not proof; a human seeing the board move is.
- [ ] **Everyone can see it.** Share the view-only URL (link or QR) so managers can open the board on their phones. Confirm one phone loads it and updates live.
- [ ] **Token is only where it should be.** The commissioner token is on the auctioneer's device only. No manager has it.
- [ ] **Fallback laptop is armed.** The backup laptop is in the room, charged, on the network, with the repo and `npm install` done and its `.env` pointing at the production database. You have done the fallback drill at least once already (see `docs/RUNBOOK.md`); tonight you are only confirming it is ready, not learning it.
- [ ] **Runbook person is briefed.** One person other than the auctioneer has `docs/RUNBOOK.md` open and owns "what to do if a screen breaks", so the auctioneer never has to stop running the room.
- [ ] **Paper backup exists.** A printed sheet of the eight managers and their budgets is in the room, as the absolute last resort.

## Five minutes before

- [ ] **Board on block, dot green, token in.**
- [ ] **Phase shows 1.**
- [ ] **Night progress reads zero sold.** (If it does not, a test sale was left in - undo it, or reset before starting.)
- [ ] Auctioneer has the cheat sheet in hand.

When all boxes are ticked, start.

## What "passed" means

A box is ticked only when you have seen the expected result with your own eyes - not because it worked last time and not because a status looked green. The single non-negotiable check is the one real test sale watched on the TV.
