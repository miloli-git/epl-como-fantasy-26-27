# Auction-night runbook - what to do when something breaks

> Held by the **runbook person** - someone other than the auctioneer - all night. Your job is to absorb any technical problem so the auctioneer never stops running the room.
> Companion docs: `docs/AUCTIONEER-CHEATSHEET.md` (running the console), `docs/PREFLIGHT.md` (checks before the room fills), `docs/DEPLOYMENT.md` (the platform picture behind all of this).

## The one thing to remember

**The database is the record, not the screen.** Every sale, trade, and correction lives in the database the moment it is recorded. If a screen freezes, goes blank, or shows OFFLINE, the data is not lost. Screens are just windows onto the database; a broken window does not lose the room. So the standing rule when anything looks wrong is: **do not re-enter a sale, do not panic, fix the window.**

## Quick triage - symptom to section

| What you see | Go to |
|---|---|
| Console top strip shows OFFLINE / "connection lost - retrying" | 1. The board went offline |
| Board or console frozen, will not update, but network is fine | 1. The board went offline |
| Phones in the room cannot load the URL; auctioneer can | 2. Venue wifi died |
| Nobody can reach the URL, but other sites still load (Vercel down) | 3. The website is down |
| App loads but every action errors / cannot read data | 4. The database is down |
| A sale from a while ago was wrong | 5. Correcting an earlier sale |
| Player photos missing (grey silhouettes) | 6. Cosmetic issues (keep going) |

Escalate only as far as you need to. Most nights you never leave section 1.

---

## 1. The board went offline

**Symptom:** the console top strip shows a red dot and "OFFLINE / connection lost - retrying", or a screen has stopped updating.

**What is actually happening:** the screens refresh themselves every couple of seconds by asking the server for the latest state. If one refresh fails (a brief network blip, a slow response), the screen shows OFFLINE and **keeps trying on its own**. It does not give up and it does not lose anything already recorded.

**Do this:**

1. **Wait ten seconds.** It usually reconnects by itself and the dot goes green again. Nothing needed.
2. If it does not, **reload the page** (pull-to-refresh on a phone, or reload in the browser). A reload rebuilds the screen entirely from the database, so it always comes back correct - the running totals, the current lot, everything.
3. If the auctioneer's console specifically is stuck, reload it. Any sale that was mid-press either landed (you will see it) or did not (re-enter it) - reload first and look before re-entering, so you never double-record.
4. If reloading does not help and it is only this one device, switch to another device: open the console URL on a spare, paste the token, carry on. The token lives per-device, so set it again on the new one.

If *every* screen is offline at once, the problem is bigger than one window - go to section 2.

---

## 2. Venue wifi died

**Symptom:** the network dropped; phones cannot load the URL. This is the most likely failure and the cheapest fix.

**Do this:**

1. Turn on the **phone hotspot** on a phone with signal.
2. Connect the auctioneer device, the TV (or its driving device), and the fallback laptop to that hotspot.
3. The live URL keeps working over the hotspot - the website is in the cloud, you only lost the room's internet.
4. Have managers rejoin the hotspot to see the board on their phones, or just watch the TV.

Room back live. No data touched.

---

## 3. The website is down (Vercel)

**Symptom:** nobody can reach the live URL, but the internet works (other sites load). Rare.

**Fix: run the site from the fallback laptop against the same database.** The laptop has the repo, `npm install` already done, and its `.env` pointing at the production database.

1. On the laptop, from the repo folder: `npm run build` then `npm start`.
2. It serves the site at `http://localhost:3000` on the laptop, and at `http://<laptop-ip>:3000` for other devices on the same network (find the laptop's IP in its network settings; on the hotspot it is usually a `192.168.x.x` address).
3. Point the TV's browser and the auctioneer's console at `http://<laptop-ip>:3000/console`.
4. Managers point their phones at `http://<laptop-ip>:3000`.

Same database, same state - nothing is lost, because the website was never the record. Target: room back live in under ten minutes. **This must have been rehearsed once before the night** (see the dress rehearsal); the night is not the time to learn it.

---

## 4. The database is down (Neon)

**Symptom:** the site loads but every action errors and no data reads. Rarest case.

**Fix: bring up the cold-standby database on the laptop from the pre-night snapshot.** This only works if you took the snapshot beforehand (see "Before the night" below).

1. Start a local Postgres on the laptop (Docker only - no other tools to install):
   `docker run --name como-pg -e POSTGRES_PASSWORD=como -p 5432:5432 -d postgres:16`
2. Create the database and restore the snapshot into it. These pipe the snapshot in from the laptop through Docker, so you do not need `psql` installed on the laptop itself:
   `docker exec -i como-pg psql -U postgres -c "create database como"`
   `docker exec -i como-pg psql -U postgres -d como < como-snapshot.sql`
3. Edit the laptop `.env` so `DATABASE_URL` points at `postgres://postgres:como@localhost:5432/como`.
4. `npm run build` then `npm start`, and point the TV and console at the laptop as in section 3.

The restored database is current as of your last snapshot. That is why the snapshot is taken as late as possible and re-taken at every break - the gap is only the handful of sales since the last snapshot. Any sales in that gap are reconstructed from the room (the last few winners and prices are easy to recall) and re-entered through the console once you are back up. Neon going down mid-auction is the rarest case; the snapshot keeps the loss to minutes, not the night.

**This restore MUST be rehearsed once during the dress rehearsal.** An unrehearsed restore is not a plan.

---

## 5. Correcting an earlier sale

The auctioneer handles a just-now slip with **Undo last** (see the cheat sheet). For an older mistake:

- **Undo last** only reverses the single most recent sale.
- To fix a sale from further back, it must be **edited** or **voided** by sale id. Both re-check every rule and both write an audit record, so budgets and maximum bids re-settle correctly and nothing is silently lost. If the console in the room does not expose the specific edit/void control you need, do it from the laptop against the database, or record the correction on paper and reconcile after the night (edit/void exists precisely so a paper correction can be entered later cleanly).
- Pause the room (top **Pause** button) while sorting out anything non-trivial, so the board is not changing under people.

## 6. Cosmetic issues (keep going)

These do not affect a single number and never justify stopping:

- **Grey silhouettes instead of player photos:** a photo did not load; the app falls back to a silhouette by design. Purely visual.
- **Nationality or height showing a dash:** that data is not in the feed. Expected, not a fault.
- **Sealed value shows a dash before a sale:** correct - values are hidden until the hammer.

## 7. The absolute last resort - paper

If every screen and both the cloud and the laptop are unavailable at once (extraordinarily unlikely), keep the auction moving on the **printed ledger**: write each winner and price by hand. When any screen comes back, enter those sales through the console (or edit/void as needed); the app is built to reconcile a paper run after the fact.

---

## Before the night (runbook person's prep)

Done once, ahead of time, so the sections above actually work:

- [ ] The **fallback laptop** has the repo, `npm install` done, `.env` pointing at the production database, and Docker installed.
- [ ] You have run **section 3** (laptop serves the site) once and seen it work.
- [ ] You have run **section 4** (snapshot restore) once and seen it work.
- [ ] A **database snapshot** command is ready to run late on the night (Docker only, no `pg_dump` to install):
  `docker run --rm postgres:16 pg_dump "<production DATABASE_URL>" > como-snapshot.sql` - take it shortly before the auction, and again at any break.
- [ ] A **printed paper ledger** (eight managers, budgets) is in the room.
- [ ] You have the live URL, the console URL, and know where the commissioner token is.

## After the night

- [ ] **Rotate the commissioner token:** change it in the host env and redeploy, so the night's token no longer works.
- [ ] The results live in the database and on the ledger screen - that is the permanent record. No extra archiving step is required for v1.
