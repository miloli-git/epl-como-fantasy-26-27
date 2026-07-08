# Dress rehearsal - the one full run-through before auction night

> This is the rehearsal a human runs, in the room, on the real TV, once before Aug 2. Its whole purpose is to turn every "should work" into "we watched it work". Book about 90 minutes.
> Do this after production is live (issue #23) and against the production URL - not a local server.
> Companion docs: `docs/RUNBOOK.md`, `docs/AUCTIONEER-CHEATSHEET.md`, `docs/PREFLIGHT.md`, `docs/DEPLOYMENT.md`.

Record only test sales that you undo as you go, so you leave no practice data in the real pool. Because the rehearsal runs against the production URL, you are using the real database - do not repoint production at a scratch database just for this (that risks leaving production misconfigured); undoing your test sales is cleaner and lower-risk.

## Who is here

- The **auctioneer** (or whoever will run the console on the night).
- The **runbook person** (owns `docs/RUNBOOK.md` and the laptop).
- At least one other person with a phone, to play "a manager watching".

## Part A - the room and the board (about 15 min)

- [ ] Put the board on the actual 77-inch TV at the live URL, TV bar set to **block**.
- [ ] Stand at the back of the room. Is every number readable? Manager names, prices, the current lot?
- [ ] **Decide light vs dark here.** Look at the board in the real room light. Pick the theme, set it, and write the decision down. This is the moment that call is made - not before.
- [ ] Open the board on a phone as "a manager". Confirm it is readable and updates live.

## Part B - a real sale, watched (about 15 min)

- [ ] Auctioneer opens the console on their device and pastes the token. Green **BOARD LIVE** dot confirmed.
- [ ] Record a test sale. **A second person watches the TV** and confirms the board updates within about two seconds and the reveal fires.
- [ ] Press **Undo last**. Confirm the board returns to normal and the manager's budget is restored on screen.
- [ ] Try an illegal sale on purpose (a price above a manager's maximum). Confirm the console refuses it with a clear reason. This proves the guard rails are real, not decoration.
- [ ] Do a **No bid** on a lot, so the auctioneer has done that once.
- [ ] Press **End phase one** (confirm the dialog) to move into phase 2. Then do one **nomination** (type a player id, press Nominate) and sell that player, so the auctioneer has run the phase-2 flow once for real.
- [ ] If a trade might happen on the night, run one test trade through the form and confirm both budgets move.

## Part C - the failure drills (about 40 min - the heart of the rehearsal)

Run each drill for real and time the ones marked. If any drill does not come back cleanly, that is a finding to fix before the night, not a "we will wing it".

- [ ] **Drill 1 - board offline / reload.** On a phone showing the board, turn wifi off for ten seconds then on. Confirm it shows OFFLINE then reconnects on its own. Then hard-reload the console and confirm it comes back with the correct totals (nothing lost). (`docs/RUNBOOK.md` section 1.)
- [ ] **Drill 2 - venue wifi dies (timed).** Turn off the room's internet. Bring the room back on a **phone hotspot**: connect the TV, the console device, and the laptop; confirm the live URL still works and a sale still records. Target: back live in under ten minutes. Write down the actual time. (`docs/RUNBOOK.md` section 2.)
- [ ] **Drill 3 - website down / laptop takes over (timed).** Simulate Vercel being unreachable: run the site from the **fallback laptop** (`npm run build && npm start`), point the TV and console at the laptop's address, and record a sale. Confirm the data is the same (same database). Target: under ten minutes. Write down the actual time. (`docs/RUNBOOK.md` section 3.)
- [ ] **Drill 4 - database cold standby (the big one).** Take a snapshot (`pg_dump`), then restore it into a local Postgres on the laptop and run the app against that, following `docs/RUNBOOK.md` section 4 step by step. Confirm the app reads correctly from the restored copy. This is the drill most likely to surface a surprise - do it slowly and fix anything that does not work. Once it works here, it counts as a real plan.

## Part D - load and leak sanity (about 15 min)

- [ ] **Polling load.** Open about ten browser tabs all pointed at the live board and leave them for ten minutes while you do the other parts. Confirm no tab starts erroring and the site stays responsive. (This checks the database connection limit is not a problem under a roomful of phones.)
- [ ] **Sealed-value leak check.** With at least one unsold player present, open the board as a normal viewer and confirm no AI valuation shows for any unsold player. The value must only appear at the hammer.
- [ ] **Write needs the token.** Confirm that without the token, the console cannot record anything (it refuses).

## After the rehearsal

- [ ] Clean up any test data (undo every test sale; confirm night progress reads zero sold again).
- [ ] Write down: the light/dark decision, the two fallback times, and anything that did not work first time (with the fix).
- [ ] Update `docs/PREFLIGHT.md` if the rehearsal taught you a check worth adding.
- [ ] Confirm the auctioneer felt comfortable and the runbook person can drive the laptop drills without notes.

If all four drills came back clean and the watched sale worked, the system is rehearsed. That is the bar for auction night.
