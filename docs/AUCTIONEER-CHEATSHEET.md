# Auctioneer cheat sheet - the one-page night-of guide

> For the person running the console on auction night. You do not need to know anything about the code.
> Print this, or keep it open on a phone. Companion docs: `docs/RUNBOOK.md` (what to do when something breaks) and `docs/PREFLIGHT.md` (the checks before the room fills up).

## Your job in one sentence

You are the only person who records anything. Managers call their bids out loud; when a player is sold, you type the winner and the price and press one button. Everyone else just watches the TV.

## The screen (the console)

Open the console URL on your device. It has three parts:

- **Top strip:** the token box, the phase, a Pause button, and a live indicator. When it says **BOARD LIVE** with a green dot, the room's TV is following you. If it says **OFFLINE / connection lost - retrying**, see "If the dot goes red" below.
- **Left column:** the player currently on the block, the eight manager buttons, the price box, and the action buttons.
- **Right column:** what is coming up next, and the night's running totals.
- **Bottom bar:** the TV control - which screen the room sees.

## Before the first player (30 seconds)

1. In the **token** box at the top, paste the commissioner token you were handed today. You only do this once; the device remembers it.
2. Check the top strip shows a green **BOARD LIVE** dot.
3. Check the bottom TV bar - tap **block** so the room sees the auction board.

If a write ever says "Set the commissioner token first" or "Token rejected", the token is missing or wrong - re-paste it.

## The core loop - every player

1. A player appears on the left as the **current lot** with their tier and opening bid.
2. Managers bid out loud. You do nothing until it is sold.
3. When the hammer falls: **tap the winning manager's button**, then **type the price** in the price box.
4. Read the verdict line under the price box:
   - **Green tick** = legal. Press **Record sale**.
   - **Red cross** = the bid is not allowed (below the opening bid, or over that manager's maximum). Fix the price or the winner. The green tick is only a courtesy; the real check happens when you press Record sale, and if the server refuses it will tell you exactly why in plain words at the top.
5. If nobody bids, press **No bid** instead. The player is set aside and can be nominated later.
6. The next player loads automatically. Repeat.

You never type totals or budgets. The app works out every manager's remaining money and maximum bid for you, live.

## The buttons

| Button | What it does |
|---|---|
| **Manager button** (x8) | Picks the winner. Greyed out = that squad is already full (15/15). |
| **Record sale** | Confirms the sale. Only lights up when the verdict is a green tick. |
| **No bid** | Nobody wanted this player; sets them aside for later nomination. |
| **Undo last** | Reverses the most recent sale (asks you to confirm first). Use it the moment you notice a slip. |
| **Enter a trade** | Opens the trade form (see below). Press again to close it. |
| **Pause** (top) | Freezes the room's board on a "paused" screen - use it for a break or a dispute. Press **Resume** to continue. |
| **End phase one** (right) | Moves the auction from phase 1 into phase 2 nominations. Only press this when phase 1 is genuinely done (asks you to confirm). |

## Phase 1 to phase 2

Phase 1 runs through the shuffled pool automatically. When it is finished (or the group agrees to move on), press **End phase one**. In phase 2 the right column changes: it shows whose turn it is to **nominate**. That manager names a player, you type the player id in the box, and press **Nominate** to put them on the block. Then you sell them the same way as always. The turn order rotates automatically and skips anyone whose squad is full.

## Trades (only if the group does one on the night)

1. Press **Enter a trade**.
2. Pick **Manager A** and **Manager B**.
3. Tick the players each side is giving up, and type any cash either side is adding.
4. Add a short reason if you like, then press **Submit trade**.
5. The app checks it is legal (ownership, budgets, squad sizes) and tells you if it is not. Budgets and maximum bids re-calculate automatically.

Do not double-tap Submit; one press is enough.

## Fixing mistakes

- **Wrong winner or price, just now:** press **Undo last**, then re-enter it correctly.
- **A mistake from earlier:** tell the group, pause if needed. Older sales can be edited or voided; that is a slightly longer step - see `docs/RUNBOOK.md`, "Correcting an earlier sale". Every change is logged automatically, so nothing is lost.

## The TV bar (bottom)

Tap one to change what the whole room sees:

- **block** - the live auction board (the default, use this most of the night).
- **reveal** - the sealed valuation reveal (fires automatically at a sale; you rarely tap this).
- **squads** - everyone's current roster.
- **ledger** - the full list of sales so far.
- **paused** - a holding screen for breaks.

## If the dot goes red (OFFLINE)

Do not panic and do not re-enter sales. The console keeps retrying on its own and usually reconnects within seconds. Nothing you already recorded is lost - the database, not the screen, is the record. If it stays red for more than a minute, open `docs/RUNBOOK.md` and follow "The board went offline". A second person should be watching that runbook all night so you can keep running the room.

## The three rules

1. One winner, one price, one **Record sale** per player.
2. If in doubt, **Pause** - it costs nothing and buys you time.
3. If a screen misbehaves, the data is safe; hand the problem to your runbook person and keep going.
