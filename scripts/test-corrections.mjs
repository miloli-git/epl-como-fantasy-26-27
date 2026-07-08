// Integration test for the corrections transactions
// (lib/corrections-core.mjs) against a live DB - no dev server needed, it
// drives the exact same undoLastSale/editSale/voidSale the routes serve.
//
// Usage: node --env-file=.env scripts/test-corrections.mjs
//
// Seeds fixture players (998xxx ids) and fixture managers (slots 980-984),
// captures the FULL app_state row (every field, including reveal_until)
// before touching it and restores it in finally; deletes all fixtures
// (pre-cleaning any stale ones from a previous crashed run first).

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig, openBidFor } from "../lib/config-core.mjs";
import { editSale, undoLastSale, voidSale } from "../lib/corrections-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });

let local;
try {
  local = JSON.parse(readFileSync("league.config.local.json", "utf8"));
} catch {
  local = undefined;
}
const cfg = buildConfig(JSON.parse(readFileSync("league.config.json", "utf8")), local);

// Fixture ids well outside real FPL ranges (test-draft uses 999xxx; this
// suite owns 998xxx and manager slots 980-984).
const ID_LO = 998900;
const ID_HI = 998999;
const P_A = 998910; // FWD, tier 1
const P_B = 998911; // MID, tier 4
const P_C = 998912; // GK, tier 4
const P_D = 998913; // MID, tier 4 - stays unsold (player-edit target)
const P_E = 998914; // FWD, tier 1 - stays unsold (player+price tier-open test)
const P_F = 998915; // FWD, tier 4 - stays unsold (quota-full player-edit test)
const P_EDIT = 998930; // FWD, tier 4 - the price-edit target
const SLOT_A = 980; // buyer A
const SLOT_B = 981; // buyer B
const SLOT_FWD_FULL = 982; // full FWD quota
const SLOT_EDIT = 983; // the max-bid edit fixture manager
const SLOT_POOR = 984; // nearly broke (budget-rejection on manager change)
const GHOST_SALE_ID = 2000000000; // int4-safe, never a real serial

const ACTOR = "test-corrections";

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}

function expectReject(name, result, code) {
  report(
    name,
    result && result.ok === false && result.code === code &&
      typeof result.message === "string" && result.message.length > 0,
    result ? `code = ${result.code}, message = "${result.message}"` : "no result",
  );
}

// --- fixture management -------------------------------------------------

let savedAppState = null;
let createdAppStateRow = false;
const managerIds = {}; // slot -> id

async function cleanup() {
  // Audit rows written by corrections carry the sale snapshot in before
  // (and/or after for edits); match on the fixture player-id range.
  await sql`
    delete from audit_log
    where action in ('sale.void', 'sale.edit', 'sale.create')
      and coalesce((before ->> 'player_id')::int, (after ->> 'player_id')::int)
          between ${ID_LO} and ${ID_HI}
  `;
  await sql`delete from sales where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from players where id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from managers where slot between 980 and 984`;
  if (createdAppStateRow) {
    await sql`delete from app_state where id = 1`;
    createdAppStateRow = false;
  } else if (savedAppState) {
    const s = savedAppState;
    await sql`
      update app_state
      set phase = ${s.phase}, paused = ${s.paused},
          current_player_id = ${s.current_player_id}, tv_view = ${s.tv_view},
          reveal_until = ${s.reveal_until},
          nomination_turn = ${s.nomination_turn},
          lot_queue = ${s.lot_queue == null ? null : sql.json(s.lot_queue)},
          pool_frozen = ${s.pool_frozen}, version = ${s.version}
      where id = 1
    `;
    savedAppState = null;
  }
}

async function currentVersion() {
  const [{ version }] = await sql`select version from app_state where id = 1`;
  return Number(version);
}

async function currentPlayerId() {
  const [{ current_player_id }] = await sql`select current_player_id from app_state where id = 1`;
  return current_player_id;
}

/** Insert a fixture sale directly (fixtures, not recordSale). */
async function seedSale(playerId, managerId, price, createdAt) {
  const [row] = await sql`
    insert into sales (player_id, manager_id, price, lot_no, phase, created_at)
    values (${playerId}, ${managerId}, ${price}, ${null}, 1, ${createdAt})
    returning id
  `;
  return row.id;
}

try {
  await cleanup(); // pre-clean stale fixtures from a previous crashed run

  // app_state singleton: create if missing, else capture the WHOLE row.
  const [existingState] = await sql`select * from app_state where id = 1`;
  if (!existingState) {
    await sql`insert into app_state (id) values (1)`;
    createdAppStateRow = true;
  } else {
    savedAppState = existingState;
  }

  // Fixture managers.
  for (const slot of [SLOT_A, SLOT_B, SLOT_FWD_FULL, SLOT_EDIT, SLOT_POOR]) {
    const [m] = await sql`
      insert into managers (slot, short, display_order)
      values (${slot}, ${"Test C" + slot}, ${slot})
      returning id
    `;
    managerIds[slot] = m.id;
  }

  // Fixture players.
  const players = [
    { id: P_A, position: "FWD", fpl_price: 13.0, tier: 1 },
    { id: P_B, position: "MID", fpl_price: 5.0, tier: 4 },
    { id: P_C, position: "GK", fpl_price: 4.5, tier: 4 },
    { id: P_D, position: "MID", fpl_price: 5.0, tier: 4 },
    { id: P_E, position: "FWD", fpl_price: 12.5, tier: 1 },
    { id: P_F, position: "FWD", fpl_price: 5.0, tier: 4 },
    { id: P_EDIT, position: "FWD", fpl_price: 5.5, tier: 4 },
  ];
  // Full FWD quota for SLOT_FWD_FULL (cfg.squad.FWD players).
  let nextId = 998920;
  const fwdFull = [];
  for (let i = 0; i < cfg.squad.FWD; i++) {
    fwdFull.push({ id: nextId++, position: "FWD", fpl_price: 4.0, tier: 4 });
  }
  // 14 fillers for SLOT_EDIT: a full squad MINUS one FWD slot (P_EDIT is the
  // 15th). Positions: GK 2, DEF 5, MID 5, FWD (quota - 1).
  nextId = 998931;
  const editFillers = [];
  for (const [pos, count] of Object.entries(cfg.squad)) {
    const n = pos === "FWD" ? count - 1 : count;
    for (let i = 0; i < n; i++) {
      editFillers.push({ id: nextId++, position: pos, fpl_price: 4.0, tier: 4 });
    }
  }
  // 10 fillers for SLOT_POOR: full GK + DEF + FWD quotas, MID left open so a
  // MID sale moved to them fails on money, not quota.
  nextId = 998950;
  const poorFillers = [];
  for (const pos of ["GK", "DEF", "FWD"]) {
    for (let i = 0; i < cfg.squad[pos]; i++) {
      poorFillers.push({ id: nextId++, position: pos, fpl_price: 4.0, tier: 4 });
    }
  }
  const allPlayers = [...players, ...fwdFull, ...editFillers, ...poorFillers].map((p) => ({
    id: p.id, code: p.id, web_name: `Corr ${p.id}`, team_short: "TST",
    position: p.position, fpl_price: p.fpl_price, tier: p.tier,
  }));
  await sql`insert into players ${sql(allPlayers, "id", "code", "web_name", "team_short", "position", "fpl_price", "tier")}`;

  // ======================================================================
  // 1. UNDO LAST SALE
  // ======================================================================
  console.log("--- undoLastSale ---");

  let versionBefore; // shared across all three sections below

  // SAFETY GUARD for the WHOLE undo section: undoLastSale deletes the newest
  // sale across ALL sales, fixture or not. The fixtures below use future
  // created_at stamps to outrank real rows, but clock skew between this
  // machine and the DB server could still let a REAL sale outrank them - and
  // then undoLastSale would delete a real sale. If any non-fixture sales
  // exist, skip the entire section rather than risk it.
  const [{ n: nonFixtureSales }] = await sql`
    select count(*)::int as n from sales
    where player_id not between ${ID_LO} and ${ID_HI}
  `;
  if (nonFixtureSales > 0) {
    console.log(
      `SKIP  entire undoLastSale section (${nonFixtureSales} non-fixture sales exist in this DB; ` +
        "clock skew could make undoLastSale delete a real sale)",
    );
  } else {
  // Board as if P_A then P_B just sold and the lot advanced to P_C.
  await sql`
    update app_state
    set phase = 1, paused = false, current_player_id = ${P_C},
        tv_view = 'reveal',
        reveal_until = ${new Date(Date.now() + 8000).toISOString()},
        lot_queue = ${sql.json([P_A, P_B, P_C])}
    where id = 1
  `;
  // IDENTICAL created_at (future, so these outrank any real sales in a
  // shared dev DB) - the newest sale must be picked by the id tiebreak.
  const tieStamp = new Date(Date.now() + 60_000).toISOString();
  const saleA1 = await seedSale(P_A, managerIds[SLOT_A], 50, tieStamp);
  const saleB1 = await seedSale(P_B, managerIds[SLOT_B], 5, tieStamp);

  versionBefore = await currentVersion();

  // Double-submit guard: an expectedSaleId pointing at anything but the
  // NEWEST sale (here the older saleA1) must bounce and write nothing.
  const staleUndo = await undoLastSale(sql, cfg, { actor: ACTOR, expectedSaleId: saleA1 });
  expectReject("undo with a stale expectedSaleId rejects", staleUndo, "stale_undo");
  const [{ n: salesAfterStale }] = await sql`
    select count(*)::int as n from sales
    where player_id between ${ID_LO} and ${ID_HI}
  `;
  report(
    "stale undo deletes nothing (sale count and version unchanged)",
    salesAfterStale === 2 && (await currentVersion()) === versionBefore,
    `fixture sales = ${salesAfterStale}`,
  );

  const undo1 = await undoLastSale(sql, cfg, { actor: ACTOR });
  report(
    "undo without expectedSaleId still works: removes the newest sale (created_at tie broken by id)",
    undo1.ok === true && undo1.undone.id === saleB1 && undo1.undone.player_id === P_B,
    undo1.ok ? `undone sale ${undo1.undone.id} (player ${undo1.undone.player_id})` : undo1.message,
  );
  const [goneB] = await sql`select 1 from sales where id = ${saleB1}`;
  const [keptA] = await sql`select 1 from sales where id = ${saleA1}`;
  report("newest sale row deleted, older sale intact", !goneB && !!keptA);

  const [stateAfterUndo] = await sql`select * from app_state where id = 1`;
  report(
    "undone player is back on the block, tv_view 'block', reveal cancelled",
    stateAfterUndo.current_player_id === P_B &&
      stateAfterUndo.tv_view === "block" &&
      stateAfterUndo.reveal_until === null,
    `current_player_id = ${stateAfterUndo.current_player_id}, tv_view = ${stateAfterUndo.tv_view}, reveal_until = ${stateAfterUndo.reveal_until}`,
  );
  report("undo bumps version by exactly 1", Number(stateAfterUndo.version) === versionBefore + 1);

  const [undoAudit] = await sql`
    select * from audit_log
    where action = 'sale.void' and entity = 'sale' and entity_id = ${saleB1}
  `;
  report(
    "undo audit row: 'sale.void', reason 'undo last sale', before = the sale, after null",
    undoAudit &&
      undoAudit.actor === ACTOR &&
      undoAudit.reason === "undo last sale" &&
      undoAudit.after === null &&
      undoAudit.before?.player_id === P_B &&
      undoAudit.before?.manager_id === managerIds[SLOT_B] &&
      undoAudit.before?.price === 5,
    undoAudit ? JSON.stringify(undoAudit.before) : "no audit row",
  );

  const undo2 = await undoLastSale(sql, cfg, { actor: ACTOR, expectedSaleId: saleA1 });
  report(
    "undo with a MATCHING expectedSaleId succeeds (removes the now-newest sale)",
    undo2.ok === true && undo2.undone.id === saleA1 && (await currentPlayerId()) === P_A,
    undo2.ok ? `undone sale ${undo2.undone.id}` : undo2.message,
  );

  // nothing_to_undo: the section-level guard proved there are no non-fixture
  // sales, and both fixture sales were just undone, so the table is empty.
  expectReject(
    "undo with no sales at all rejects",
    await undoLastSale(sql, cfg, { actor: ACTOR }),
    "nothing_to_undo",
  );

  // Re-sale after undo: the UNIQUE(player_id) row is gone, so inserting the
  // same player again must succeed.
  const resold = await seedSale(P_B, managerIds[SLOT_A], 5, new Date().toISOString());
  report("undone player is re-sellable (insert succeeds)", Number.isInteger(resold));
  await sql`delete from sales where id = ${resold}`;
  } // end of the non-fixture-sales guard around the undo section

  // ======================================================================
  // 2. EDIT SALE
  // ======================================================================
  console.log("--- editSale ---");

  // The double-count fixture (budget 3000, reserve minOpenBid = lowest tier
  // open): SLOT_EDIT owns a FULL squad of 15 including the P_EDIT sale at
  // $500, total spend $2,900 ($2,400 across the other 14). Raising P_EDIT to
  // $600 is legal ONLY when the sale's own $500 is excluded first:
  //   correct: spent 2400, remaining 600, openSlots 1, maxBid 600 - reserve*0
  //            = 600 -> 600 passes exactly.
  //   naive (sale left in): spent 2900, openSlots 0 -> squad "complete" /
  //            remaining 100 -> any path rejects.
  const now = new Date().toISOString();
  const editSaleId = await seedSale(P_EDIT, managerIds[SLOT_EDIT], 500, now);
  const fillerPrices = [190, ...Array(editFillers.length - 1).fill(170)]; // 190 + 13*170 = 2400
  for (const [i, p] of editFillers.entries()) {
    await seedSale(p.id, managerIds[SLOT_EDIT], fillerPrices[i], now);
  }
  // Full FWD quota manager.
  for (const p of fwdFull) await seedSale(p.id, managerIds[SLOT_FWD_FULL], 5, now);
  // Poor manager: 10 players, $2,960 spent, MID open. remaining 40,
  // openSlots 5, maxBid = 40 - 5*4 = 20.
  for (const p of poorFillers) await seedSale(p.id, managerIds[SLOT_POOR], 296, now);
  // Targets for the manager-change tests.
  const saleFwd = await seedSale(P_A, managerIds[SLOT_A], 50, now); // FWD tier 1
  const saleMid = await seedSale(P_B, managerIds[SLOT_B], 50, now); // MID tier 4

  // Pin the block so we can prove edits never touch it.
  await sql`update app_state set current_player_id = ${P_C}, tv_view = 'block' where id = 1`;

  versionBefore = await currentVersion();

  expectReject(
    "edit without a reason rejects",
    await editSale(sql, cfg, { saleId: editSaleId, price: 550, reason: "", actor: ACTOR }),
    "missing_reason",
  );
  const [unchanged] = await sql`select price from sales where id = ${editSaleId}`;
  report(
    "rejected edit changes nothing (price intact, version unchanged)",
    unchanged.price === 500 && (await currentVersion()) === versionBefore,
  );

  const noChange = await editSale(sql, cfg, {
    saleId: editSaleId, reason: "no fields", actor: ACTOR,
  });
  expectReject("edit with neither managerId nor price rejects", noChange, "nothing_to_change");
  report(
    "nothing_to_change message reads 'Nothing to change.'",
    noChange.ok === false && noChange.message === "Nothing to change.",
    noChange.message,
  );

  // THE subtlety: raise 500 -> 600 on a full squad. Passes only when max bid
  // is computed excluding this sale's own current price from spend.
  const raise = await editSale(sql, cfg, {
    saleId: editSaleId, price: 600, reason: "hammer price mis-keyed", actor: ACTOR,
  });
  report(
    "price edit validates max bid EXCLUDING the sale itself (500 -> 600 passes)",
    raise.ok === true && raise.sale.price === 600 && raise.before.price === 500,
    raise.ok ? `price now ${raise.sale.price}` : `${raise.code}: ${raise.message}`,
  );
  const [editAudit] = await sql`
    select * from audit_log
    where action = 'sale.edit' and entity = 'sale' and entity_id = ${editSaleId}
    order by id desc limit 1
  `;
  report(
    "edit audit row: before/after prices + required reason",
    editAudit &&
      editAudit.actor === ACTOR &&
      editAudit.before?.price === 500 &&
      editAudit.after?.price === 600 &&
      editAudit.reason === "hammer price mis-keyed",
    editAudit ? `before ${editAudit.before?.price} -> after ${editAudit.after?.price}` : "no audit row",
  );
  report("legal edit bumps version by exactly 1", (await currentVersion()) === versionBefore + 1);

  const overMax = await editSale(sql, cfg, {
    saleId: editSaleId, price: 601, reason: "test over", actor: ACTOR,
  });
  expectReject("price over the recomputed max bid rejects", overMax, "over_max_bid");
  report(
    "over-max message names the exact max bid ($600)",
    overMax.ok === false && overMax.message.includes("$600"),
    overMax.message,
  );

  const quotaFull = await editSale(sql, cfg, {
    saleId: saleFwd, managerId: managerIds[SLOT_FWD_FULL], reason: "wrong buyer", actor: ACTOR,
  });
  expectReject("manager change into a full position quota rejects", quotaFull, "position_full");
  report(
    "quota message names the filled quota",
    quotaFull.ok === false && quotaFull.message.includes(`${cfg.squad.FWD}/${cfg.squad.FWD}`),
    quotaFull.message,
  );

  const overBudget = await editSale(sql, cfg, {
    saleId: saleMid, managerId: managerIds[SLOT_POOR], reason: "wrong buyer", actor: ACTOR,
  });
  expectReject("manager change past the new manager's max bid rejects", overBudget, "over_max_bid");
  report(
    "budget message names the new manager's max bid ($20)",
    overBudget.ok === false && overBudget.message.includes("$20"),
    overBudget.message,
  );

  expectReject(
    "editing a nonexistent sale id rejects",
    await editSale(sql, cfg, { saleId: GHOST_SALE_ID, price: 10, reason: "x", actor: ACTOR }),
    "not_found",
  );

  // --- player edits (issue #10: the wrong-player correction) --------------

  // Onto an already-sold player: P_A is sold to SLOT_A for $50. Must name
  // the current owner and price, recordSale-style.
  const ontoSold = await editSale(sql, cfg, {
    saleId: saleMid, playerId: P_A, reason: "wrong player", actor: ACTOR,
  });
  expectReject("player edit onto an already-sold player rejects", ontoSold, "already_sold");
  report(
    "already_sold message names the current owner and price",
    ontoSold.ok === false &&
      ontoSold.message.includes(`Test C${SLOT_A}`) &&
      ontoSold.message.includes("$50"),
    ontoSold.message,
  );

  // Onto the player currently ON THE BLOCK: P_C was pinned as
  // current_player_id above and is unsold here, so the ONLY thing rejecting
  // this edit is the on-block guard (marking the live lot as sold would
  // strand a sold player as the current lot).
  versionBefore = await currentVersion();
  const ontoBlock = await editSale(sql, cfg, {
    saleId: saleMid, playerId: P_C, reason: "wrong player", actor: ACTOR,
  });
  expectReject("player edit onto the on-block player rejects", ontoBlock, "player_on_block");
  report(
    "player_on_block message names the player and says to resolve the lot",
    ontoBlock.ok === false &&
      ontoBlock.message.includes(`CORR ${P_C}`) &&
      ontoBlock.message.includes("resolve the lot first"),
    ontoBlock.message,
  );
  const [saleMidUntouched] = await sql`select player_id from sales where id = ${saleMid}`;
  report(
    "on-block rejection writes nothing (sale row and version unchanged)",
    saleMidUntouched.player_id === P_B && (await currentVersion()) === versionBefore,
  );

  // Onto a nonexistent player.
  expectReject(
    "player edit onto a nonexistent player rejects",
    await editSale(sql, cfg, {
      saleId: saleMid, playerId: GHOST_SALE_ID, reason: "typo id", actor: ACTOR,
    }),
    "unknown_player",
  );

  // Quota re-check against the NEW player's position: SLOT_FWD_FULL's FWD
  // quota is full; a GK sale of theirs cannot be edited onto another FWD.
  const saleGk = await seedSale(P_C, managerIds[SLOT_FWD_FULL], 5, now);
  const fwdOnFull = await editSale(sql, cfg, {
    saleId: saleGk, playerId: P_F, reason: "wrong player", actor: ACTOR,
  });
  expectReject(
    "player edit to a position the manager has full rejects",
    fwdOnFull,
    "position_full",
  );
  report(
    "position_full message names the filled FWD quota",
    fwdOnFull.ok === false &&
      fwdOnFull.message.includes(`${cfg.squad.FWD}/${cfg.squad.FWD}`),
    fwdOnFull.message,
  );

  // Player + price together: the floor is the NEW player's tier open. P_E is
  // tier 1; a price legal for saleMid's current tier-4 player must bounce.
  const t1Open = openBidFor(cfg, 1);
  const combo = await editSale(sql, cfg, {
    saleId: saleMid, playerId: P_E, price: t1Open - 1, reason: "wrong player and price", actor: ACTOR,
  });
  expectReject(
    "player+price edit validates the floor against the NEW player's tier open",
    combo,
    "below_open",
  );
  report(
    "below_open message names the tier-1 opening bid",
    combo.ok === false && combo.message.includes(`$${t1Open}`),
    combo.message,
  );

  // The happy path: P_B (MID, sold on saleMid) was the wrong player; the
  // hammer actually fell on P_D (MID, unsold, same tier).
  versionBefore = await currentVersion();
  const playerEdit = await editSale(sql, cfg, {
    saleId: saleMid, playerId: P_D, reason: "wrong player hammered", actor: ACTOR,
  });
  report(
    "player edit to an unsold same-position player passes",
    playerEdit.ok === true &&
      playerEdit.sale.player_id === P_D &&
      playerEdit.before.player_id === P_B &&
      playerEdit.sale.price === 50 &&
      playerEdit.sale.manager_id === managerIds[SLOT_B],
    playerEdit.ok
      ? `player ${playerEdit.before.player_id} -> ${playerEdit.sale.player_id}`
      : `${playerEdit.code}: ${playerEdit.message}`,
  );
  const [saleMidRow] = await sql`select player_id from sales where id = ${saleMid}`;
  report("sale row now carries the new player_id", saleMidRow.player_id === P_D);
  const [playerAudit] = await sql`
    select * from audit_log
    where action = 'sale.edit' and entity = 'sale' and entity_id = ${saleMid}
    order by id desc limit 1
  `;
  report(
    "player-edit audit row shows the old and new player_id + required reason",
    playerAudit &&
      playerAudit.actor === ACTOR &&
      playerAudit.before?.player_id === P_B &&
      playerAudit.after?.player_id === P_D &&
      playerAudit.reason === "wrong player hammered",
    playerAudit
      ? `before ${playerAudit.before?.player_id} -> after ${playerAudit.after?.player_id}`
      : "no audit row",
  );
  report(
    "player edit bumps version by exactly 1",
    (await currentVersion()) === versionBefore + 1,
  );

  report("edits never touch the block", (await currentPlayerId()) === P_C);

  // ======================================================================
  // 3. VOID SALE
  // ======================================================================
  console.log("--- voidSale ---");

  // Three sales in time order; void the MIDDLE one.
  await sql`delete from sales where player_id in (${P_A}, ${P_B}, ${P_C})`;
  const t = Date.now();
  const s1 = await seedSale(P_A, managerIds[SLOT_A], 50, new Date(t - 180_000).toISOString());
  const s2 = await seedSale(P_B, managerIds[SLOT_B], 50, new Date(t - 120_000).toISOString());
  const s3 = await seedSale(P_C, managerIds[SLOT_A], 5, new Date(t - 60_000).toISOString());

  versionBefore = await currentVersion();

  expectReject(
    "void without a reason rejects",
    await voidSale(sql, cfg, { saleId: s2, reason: "  ", actor: ACTOR }),
    "missing_reason",
  );

  const voided = await voidSale(sql, cfg, { saleId: s2, reason: "duplicate entry", actor: ACTOR });
  report(
    "voiding the middle sale succeeds",
    voided.ok === true && voided.voided.id === s2 && voided.voided.player_id === P_B,
    voided.ok ? `voided sale ${voided.voided.id}` : voided.message,
  );
  const remaining = await sql`
    select id from sales where player_id in (${P_A}, ${P_B}, ${P_C}) order by id
  `;
  report(
    "voided row gone, the two neighbours intact",
    remaining.length === 2 && remaining[0].id === s1 && remaining[1].id === s3,
    `remaining sale ids: ${remaining.map((r) => r.id).join(", ")}`,
  );
  report(
    "void never touches the block (current_player_id unchanged)",
    (await currentPlayerId()) === P_C,
  );
  const [voidAudit] = await sql`
    select * from audit_log
    where action = 'sale.void' and entity = 'sale' and entity_id = ${s2}
  `;
  report(
    "void audit row: before = the sale, after null, required reason",
    voidAudit &&
      voidAudit.actor === ACTOR &&
      voidAudit.reason === "duplicate entry" &&
      voidAudit.after === null &&
      voidAudit.before?.player_id === P_B &&
      voidAudit.before?.price === 50,
    voidAudit ? JSON.stringify(voidAudit.before) : "no audit row",
  );
  report("void bumps version by exactly 1", (await currentVersion()) === versionBefore + 1);

  expectReject(
    "voiding a nonexistent sale id rejects",
    await voidSale(sql, cfg, { saleId: GHOST_SALE_ID, reason: "x", actor: ACTOR }),
    "not_found",
  );
  const ghost = await voidSale(sql, cfg, { saleId: GHOST_SALE_ID, reason: "x", actor: ACTOR });
  report(
    "not_found message names the sale id",
    ghost.ok === false && ghost.message === `Sale #${GHOST_SALE_ID} not found.`,
    ghost.message,
  );

  const resale = await seedSale(P_B, managerIds[SLOT_A], 5, new Date().toISOString());
  report("voided player is re-sellable (insert succeeds)", Number.isInteger(resale));

  // Reveal handling: voiding an OLDER sale mid-reveal must leave the TV
  // alone (the running reveal belongs to a different, still-valid sale)...
  await sql`
    update app_state
    set tv_view = 'reveal',
        reveal_until = ${new Date(Date.now() + 8000).toISOString()}
    where id = 1
  `;
  const oldVoid = await voidSale(sql, cfg, {
    saleId: s1, reason: "older void mid-reveal", actor: ACTOR,
  });
  const [stateOldVoid] = await sql`select tv_view, reveal_until from app_state where id = 1`;
  report(
    "voiding an OLDER sale mid-reveal leaves the reveal running",
    oldVoid.ok === true &&
      stateOldVoid.tv_view === "reveal" &&
      stateOldVoid.reveal_until !== null,
    `tv_view = ${stateOldVoid.tv_view}, reveal_until ${stateOldVoid.reveal_until === null ? "null" : "set"}`,
  );

  // ...but voiding the NEWEST sale mid-reveal is voiding the very sale the
  // TV is revealing, so the reveal must be cancelled (tv 'block', timer
  // cleared). Future created_at so this fixture outranks any real sales.
  const sNewest = await seedSale(
    P_A, managerIds[SLOT_B], 60, new Date(Date.now() + 60_000).toISOString(),
  );
  const newestVoid = await voidSale(sql, cfg, {
    saleId: sNewest, reason: "newest void mid-reveal", actor: ACTOR,
  });
  const [stateNewestVoid] = await sql`select tv_view, reveal_until from app_state where id = 1`;
  report(
    "voiding the NEWEST sale mid-reveal clears the reveal (tv 'block', timer null)",
    newestVoid.ok === true &&
      stateNewestVoid.tv_view === "block" &&
      stateNewestVoid.reveal_until === null,
    `tv_view = ${stateNewestVoid.tv_view}, reveal_until = ${stateNewestVoid.reveal_until}`,
  );
} catch (err) {
  console.error("test-corrections failed to run:", err);
  failed = true;
} finally {
  try {
    await cleanup();
  } catch (err) {
    console.error("cleanup failed:", err.message);
    failed = true;
  }
  await sql.end();
}

process.exit(failed ? 1 : 0);
