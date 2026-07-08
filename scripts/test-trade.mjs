// Integration + concurrency test for the trade transaction
// (lib/trade-core.mjs) and the trade-aware derivation seam (issues #15, #18).
// Drives the exact same recordTrade the POST /api/trade route serves, against
// a live scratch DB - no dev server needed.
//
// Usage: node --env-file=<scratch>.env scripts/test-trade.mjs
//
// Fixture ids: 9997xx players, manager slots 960..969 (distinct from
// test-draft 9999xx/990-993 and test-concurrency 9998xx/970-980 so suites
// never collide). Rejection cases write NOTHING (they are pre-commit checks),
// so many run against one fixture without cleanup between them; the mutating
// cases (happy path, reverse, the sale/trade race) run last and clean up.

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";
import { recordSale } from "../lib/draft-core.mjs";
import { recordTrade } from "../lib/trade-core.mjs";
import { buildStatePayload } from "../lib/state-core.mjs";
import { editSale, voidSale } from "../lib/corrections-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with `node --env-file=<scratch>.env ...`.");
  process.exit(1);
}
const sql = postgres(url, { max: 6 });

let local;
try {
  local = JSON.parse(readFileSync("league.config.local.json", "utf8"));
} catch {
  local = undefined;
}
const cfg = buildConfig(JSON.parse(readFileSync("league.config.json", "utf8")), local);

const ID_LO = 999700;
const ID_HI = 999799;
const P_A_MID = 999700; // A owns, MID, $500
const P_A_FWD = 999701; // A owns, FWD, $300
const P_B_GK = 999702; // B owns, GK, $400
const P_RACE = 999704; // unsold; the sale/trade race target (MID)
const P_C_FWD = [999710, 999711, 999712]; // C owns 3 FWD -> quota full
const SLOT_A = 960;
const SLOT_B = 961;
const SLOT_C = 962;
const ACTOR = "test-trade";

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

let savedAppState = null;
let createdAppStateRow = false;
let A, B, C; // manager ids

async function cleanup() {
  const fx = await sql`select id from managers where slot between 960 and 969`;
  const ids = fx.map((r) => r.id);
  if (ids.length) {
    await sql`delete from audit_log where action = 'trade.create' and (after->>'managerA')::int in ${sql(ids)}`;
    await sql`delete from trade_players where from_manager in ${sql(ids)} or to_manager in ${sql(ids)}`;
    await sql`delete from trades where manager_a in ${sql(ids)} or manager_b in ${sql(ids)}`;
  }
  await sql`delete from audit_log where action = 'sale.create' and (after->>'playerId')::int between ${ID_LO} and ${ID_HI}`;
  await sql`delete from trade_players where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from lot_events where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from sales where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from players where id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from managers where slot between 960 and 969`;
  if (createdAppStateRow) {
    await sql`delete from app_state where id = 1`;
    createdAppStateRow = false;
  } else if (savedAppState) {
    const s = savedAppState;
    await sql`
      update app_state
      set phase = ${s.phase}, paused = ${s.paused},
          current_player_id = ${s.current_player_id}, tv_view = ${s.tv_view},
          reveal_until = ${s.reveal_until}, nomination_turn = ${s.nomination_turn},
          lot_queue = ${s.lot_queue == null ? null : sql.json(s.lot_queue)},
          pool_frozen = ${s.pool_frozen}, version = ${s.version}
      where id = 1
    `;
    savedAppState = null;
  }
}

async function version() {
  const [{ version: v }] = await sql`select version from app_state where id = 1`;
  return Number(v);
}
async function ownerOf(playerId) {
  // Current owner id through the state payload's manager squads.
  const st = await buildStatePayload(sql, cfg);
  const m = st.managers.find((mm) => mm.squad.some((p) => p.playerId === playerId));
  return m ? m.id : null;
}
async function remainingOf(id) {
  const st = await buildStatePayload(sql, cfg);
  return st.managers.find((m) => m.id === id)?.remaining ?? null;
}

try {
  await cleanup();

  const [existingState] = await sql`select * from app_state where id = 1`;
  if (!existingState) {
    await sql`insert into app_state (id) values (1)`;
    createdAppStateRow = true;
  } else {
    savedAppState = existingState;
  }

  const bottomTier = cfg.tiers[cfg.tiers.length - 1].tier;
  [A] = (await sql`insert into managers (slot, short, display_order) values (${SLOT_A}, 'Trade A', ${SLOT_A}) returning id`).map((r) => r.id);
  [B] = (await sql`insert into managers (slot, short, display_order) values (${SLOT_B}, 'Trade B', ${SLOT_B}) returning id`).map((r) => r.id);
  [C] = (await sql`insert into managers (slot, short, display_order) values (${SLOT_C}, 'Trade C', ${SLOT_C}) returning id`).map((r) => r.id);

  await sql`
    insert into players (id, code, web_name, team_short, position, fpl_price, tier) values
      (${P_A_MID}, ${P_A_MID}, 'A Mid', 'TST', 'MID', 5.0, ${bottomTier}),
      (${P_A_FWD}, ${P_A_FWD}, 'A Fwd', 'TST', 'FWD', 5.0, ${bottomTier}),
      (${P_B_GK}, ${P_B_GK}, 'B Gk', 'TST', 'GK', 5.0, ${bottomTier}),
      (${P_RACE}, ${P_RACE}, 'Race Mid', 'TST', 'MID', 5.0, ${bottomTier}),
      (${P_C_FWD[0]}, ${P_C_FWD[0]}, 'C Fwd1', 'TST', 'FWD', 5.0, ${bottomTier}),
      (${P_C_FWD[1]}, ${P_C_FWD[1]}, 'C Fwd2', 'TST', 'FWD', 5.0, ${bottomTier}),
      (${P_C_FWD[2]}, ${P_C_FWD[2]}, 'C Fwd3', 'TST', 'FWD', 5.0, ${bottomTier})
  `;
  // Establish ownership directly (bypass recordSale; trades don't care how a
  // sale was recorded, only who owns what now).
  await sql`
    insert into sales (player_id, manager_id, price, lot_no, phase) values
      (${P_A_MID}, ${A}, 500, 1, 1),
      (${P_A_FWD}, ${A}, 300, 2, 1),
      (${P_B_GK}, ${B}, 400, 3, 1),
      (${P_C_FWD[0]}, ${C}, 10, 4, 1),
      (${P_C_FWD[1]}, ${C}, 10, 5, 1),
      (${P_C_FWD[2]}, ${C}, 10, 6, 1)
  `;
  await sql`update app_state set paused = false, phase = 1, current_player_id = null where id = 1`;

  // Baseline derived numbers (proves the seam reads sales correctly pre-trade).
  report("baseline: A remaining 2200 (owns $800)", (await remainingOf(A)) === cfg.budget - 800, `${await remainingOf(A)}`);
  report("baseline: B remaining 2600 (owns $400)", (await remainingOf(B)) === cfg.budget - 400, `${await remainingOf(B)}`);

  // --- rejection cases (write nothing) ---------------------------------
  const vBefore = await version();
  expectReject("reject: same manager", await recordTrade(sql, cfg, { managerA: A, managerB: A, playersAToB: [P_A_MID], actor: ACTOR }), "same_manager");
  expectReject("reject: unknown manager", await recordTrade(sql, cfg, { managerA: A, managerB: 999999, playersAToB: [P_A_MID], actor: ACTOR }), "unknown_manager");
  expectReject("reject: negative cash", await recordTrade(sql, cfg, { managerA: A, managerB: B, cashAToB: -5, actor: ACTOR }), "bad_cash");
  expectReject("reject: players not an array", await recordTrade(sql, cfg, { managerA: A, managerB: B, playersAToB: 5, actor: ACTOR }), "bad_players");
  expectReject("reject: same player both directions (overlap)", await recordTrade(sql, cfg, { managerA: A, managerB: B, playersAToB: [P_A_MID], playersBToA: [P_A_MID], actor: ACTOR }), "player_overlap");
  expectReject("reject: empty trade (no players, no cash)", await recordTrade(sql, cfg, { managerA: A, managerB: B, actor: ACTOR }), "empty_trade");
  expectReject("reject: giving away a player you do not own", await recordTrade(sql, cfg, { managerA: A, managerB: B, playersAToB: [P_B_GK], actor: ACTOR }), "not_owned");
  expectReject("reject: trading an unsold player", await recordTrade(sql, cfg, { managerA: A, managerB: B, playersAToB: [P_RACE], actor: ACTOR }), "not_owned");
  expectReject("reject: cash exceeds budget (negative budget)", await recordTrade(sql, cfg, { managerA: A, managerB: B, cashAToB: 5000, actor: ACTOR }), "negative_budget");
  expectReject("reject: incoming player breaches position quota", await recordTrade(sql, cfg, { managerA: A, managerB: C, playersAToB: [P_A_FWD], actor: ACTOR }), "quota_exceeded");
  report("rejections wrote nothing (version unchanged)", (await version()) === vBefore, `${vBefore} -> ${await version()}`);
  const [{ n: tradeRowsAfterRejects }] = await sql`select count(*)::int as n from trades where manager_a = ${A} or manager_b = ${A} or manager_a = ${C}`;
  report("rejections wrote no trade rows", tradeRowsAfterRejects === 0, `${tradeRowsAfterRejects}`);

  // --- happy path: A gives $500 MID to B, B pays A $200 ----------------
  const vBeforeTrade = await version();
  const t1 = await recordTrade(sql, cfg, { managerA: A, managerB: B, playersAToB: [P_A_MID], cashBToA: 200, reason: "swap", actor: ACTOR });
  report("happy: trade recorded", t1.ok === true, t1.ok ? `tradeId ${t1.tradeId}` : t1.message);
  report("happy: version bumped exactly once", (await version()) === vBeforeTrade + 1, `${vBeforeTrade} -> ${await version()}`);
  // Salary travels ($500 leaves A, lands on B); cash settles ($200 to A).
  report("happy: A remaining 2900 (owns $300, +$200 cash)", (await remainingOf(A)) === 2900, `${await remainingOf(A)}`);
  report("happy: B remaining 1900 (owns $900, -$200 cash)", (await remainingOf(B)) === 1900, `${await remainingOf(B)}`);
  report("happy: returned summary matches board (A)", t1.ok && t1.managerA.remaining === 2900, t1.ok ? `${t1.managerA.remaining}` : "-");
  report("happy: returned summary matches board (B)", t1.ok && t1.managerB.remaining === 1900, t1.ok ? `${t1.managerB.remaining}` : "-");
  report("happy: total remaining conserved (4800)", (await remainingOf(A)) + (await remainingOf(B)) === 4800, "");
  report("happy: player now owned by B", (await ownerOf(P_A_MID)) === B, `owner ${await ownerOf(P_A_MID)}`);
  const [{ n: legRows }] = await sql`select count(*)::int as n from trade_players where trade_id = ${t1.ok ? t1.tradeId : -1} and player_id = ${P_A_MID} and from_manager = ${A} and to_manager = ${B}`;
  report("happy: trade_players leg written (A -> B)", legRows === 1, `${legRows}`);
  const [{ n: auditRows }] = await sql`select count(*)::int as n from audit_log where action = 'trade.create' and entity_id = ${t1.ok ? t1.tradeId : -1}`;
  report("happy: audit row written", auditRows === 1, `${auditRows}`);

  // --- reverse trade unwinds it (the v1 "undo a trade" mechanism) -------
  const t2 = await recordTrade(sql, cfg, { managerA: B, managerB: A, playersAToB: [P_A_MID], cashBToA: 200, reason: "reverse", actor: ACTOR });
  report("reverse: recorded", t2.ok === true, t2.ok ? "" : t2.message);
  report("reverse: A back to 2200", (await remainingOf(A)) === 2200, `${await remainingOf(A)}`);
  report("reverse: B back to 2600", (await remainingOf(B)) === 2600, `${await remainingOf(B)}`);
  report("reverse: player back with A", (await ownerOf(P_A_MID)) === A, `owner ${await ownerOf(P_A_MID)}`);

  // --- #15 regression: a traded-away player un-completes the giver ------
  // (proves managerCompleteness/derivation counts ownership through trades.)
  {
    const st = await buildStatePayload(sql, cfg);
    const cState = st.managers.find((m) => m.id === C);
    report("#15 regression: C shows FWD 3/3 filled through the seam", cState.fills.FWD === 3, `${cState.fills.FWD}`);
    // Move one of C's FWD to B; C's FWD count must drop to 2 on the board.
    const t3 = await recordTrade(sql, cfg, { managerA: C, managerB: B, playersAToB: [P_C_FWD[0]], actor: ACTOR });
    report("#15 regression: trade recorded", t3.ok === true, t3.ok ? "" : t3.message);
    const st2 = await buildStatePayload(sql, cfg);
    report("#15 regression: C now FWD 2/3 (ownership derived through trades)", st2.managers.find((m) => m.id === C).fills.FWD === 2, `${st2.managers.find((m) => m.id === C).fills.FWD}`);
    report("#15 regression: B now holds the moved FWD", st2.managers.find((m) => m.id === B).squad.some((p) => p.playerId === P_C_FWD[0]), "");
    // put it back so the race scenario starts clean
    await recordTrade(sql, cfg, { managerA: B, managerB: C, playersAToB: [P_C_FWD[0]], actor: ACTOR });
  }

  // --- correction guard: a traded player's sale cannot be edited/voided ---
  // Regression for the reviewer blocker + the adversary corruption: voiding or
  // editing a sale whose player was later traded leaves a dangling movement
  // that re-latches on the next sale, sending the player to the wrong manager
  // and pushing an uninvolved manager negative/over-quota. The guard blocks the
  // correction outright, which is the only reachable way to strand a movement.
  {
    const [s700] = await sql`select id from sales where player_id = ${P_A_MID}`;
    // p_a_mid carries A->B and B->A movements from the happy + reverse trades.
    const v = await voidSale(sql, cfg, { saleId: s700.id, reason: "test", actor: ACTOR });
    expectReject("guard: void of a traded player's sale is rejected", v, "player_traded");
    const e = await editSale(sql, cfg, { saleId: s700.id, price: 501, reason: "test", actor: ACTOR });
    expectReject("guard: edit of a traded player's sale is rejected", e, "player_traded");
    const [{ n: stillThere }] = await sql`select count(*)::int as n from sales where id = ${s700.id}`;
    report("guard: the traded sale still exists (void was blocked)", stillThere === 1, `${stillThere}`);
    report("guard: player still owned by A, no corruption", (await ownerOf(P_A_MID)) === A, `owner ${await ownerOf(P_A_MID)}`);
  }

  // --- guard does NOT over-block: an UNTRADED sale still voids normally ----
  {
    await sql`insert into players (id, code, web_name, team_short, position, fpl_price, tier) values (999707, 999707, 'Clean', 'TST', 'DEF', 5.0, ${bottomTier})`;
    const [clean] = await sql`insert into sales (player_id, manager_id, price, lot_no, phase) values (999707, ${C}, 20, 99, 1) returning id`;
    const v = await voidSale(sql, cfg, { saleId: clean.id, reason: "test", actor: ACTOR });
    report("guard: an untraded sale still voids normally", v.ok === true, v.ok ? "" : v.message);
    const [{ n }] = await sql`select count(*)::int as n from sales where id = ${clean.id}`;
    report("guard: the untraded sale is gone after void", n === 0, `${n}`);
  }

  // --- concurrency: a trade racing a SALE for the same player ----------
  // p_race is on the block, unsold. Fire (sale: race -> A) and (trade: A moves
  // race -> C) simultaneously. They serialise on the app_state lock, so:
  //   sale-first  -> A owns it, then the trade moves it to C  (both ok)
  //   trade-first -> A does not own it yet, trade rejects not_owned; sale lands
  // Either way: exactly ONE sale row, exactly ONE owner, no negative budgets.
  async function resetRace() {
    const tp = await sql`select distinct trade_id from trade_players where player_id = ${P_RACE}`;
    const tids = tp.map((r) => r.trade_id);
    await sql`delete from trade_players where player_id = ${P_RACE}`;
    if (tids.length) {
      await sql`delete from trades where id in ${sql(tids)}`;
      await sql`delete from audit_log where action = 'trade.create' and entity_id in ${sql(tids)}`;
    }
    await sql`delete from audit_log where action = 'sale.create' and (after->>'playerId')::int = ${P_RACE}`;
    await sql`delete from lot_events where player_id = ${P_RACE}`;
    await sql`delete from sales where player_id = ${P_RACE}`;
    await sql`update app_state set paused = false, phase = 1, current_player_id = ${P_RACE}, tv_view = 'block' where id = 1`;
  }

  let raceOk = true;
  for (let i = 1; i <= 3; i++) {
    await resetRace();
    const [saleRes, tradeRes] = await Promise.allSettled([
      recordSale(sql, cfg, { playerId: P_RACE, managerId: A, price: 5, actor: ACTOR }),
      recordTrade(sql, cfg, { managerA: A, managerB: C, playersAToB: [P_RACE], actor: ACTOR }),
    ]);
    const noThrow = saleRes.status === "fulfilled" && tradeRes.status === "fulfilled";
    const sale = saleRes.value;
    const trade = tradeRes.value;
    const [{ n: saleRows }] = await sql`select count(*)::int as n from sales where player_id = ${P_RACE}`;
    const owner = await ownerOf(P_RACE);
    // Invariant: sale always lands (it does not race another sale); exactly one
    // sale row; owner is C iff the trade succeeded, else A.
    const coherent =
      noThrow &&
      sale.ok === true &&
      saleRows === 1 &&
      ((trade.ok === true && owner === C) || (trade.ok === false && trade.code === "not_owned" && owner === A));
    report(`race #${i}: exactly one coherent outcome`, coherent, `sale.ok=${sale.ok}, trade.ok=${trade.ok}${trade.ok === false ? "/" + trade.code : ""}, saleRows=${saleRows}, owner=${owner === C ? "C" : owner === A ? "A" : owner}`);
    if (!coherent) raceOk = false;
    // No negative budgets among fixtures.
    const st = await buildStatePayload(sql, cfg);
    const anyNeg = st.managers.filter((m) => [A, B, C].includes(m.id)).some((m) => m.remaining < 0);
    report(`race #${i}: no fixture manager over budget`, !anyNeg, "");
  }
  report("race: all iterations coherent", raceOk, "");
} catch (err) {
  console.error("test-trade failed to run:", err);
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
