// Integration test for the trades-log assembly (lib/trades-core.mjs, #58).
// Drives the exact core the /api/trades route serves, against the live DB it
// is pointed at.
//   node --env-file=<env> scripts/test-trades.mjs
//
// Good battery citizen (see #50): reads real state first (most assertions run
// against whatever trades already exist), then writes exactly one fixture
// trade - via recordTrade, the same write path the auction console uses - to
// exercise the voided-trade exclusion, and removes every row it touched in
// finally. Fixture ids: 9996xx players, manager slots 940..941 (distinct from
// test-trade's 960..969, test-lot/test-draft-concurrency's 970..980,
// test-corrections's 980..984 and test-draft's 990..993, so suites never
// collide even outside the shared test-all baseline reset).

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";
import { recordTrade } from "../lib/trade-core.mjs";
import { buildTradesPayload } from "../lib/trades-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with `node --env-file=<env> scripts/test-trades.mjs`.");
  process.exit(1);
}

const cfg = buildConfig(JSON.parse(readFileSync("league.config.json", "utf8")), undefined);
const sql = postgres(url, { max: 1 });

const ID_LO = 999600;
const ID_HI = 999699;
const P_MID = 999600; // A owns, MID
const SLOT_A = 940;
const SLOT_B = 941;
const ACTOR = "test-trades";

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed = true;
}

let savedAppState = null;
let createdAppStateRow = false;

async function cleanup() {
  const fx = await sql`select id from managers where slot in (${SLOT_A}, ${SLOT_B})`;
  const ids = fx.map((r) => r.id);
  if (ids.length) {
    await sql`delete from audit_log where action = 'trade.create' and (after->>'managerA')::int in ${sql(ids)}`;
    await sql`delete from trade_players where from_manager in ${sql(ids)} or to_manager in ${sql(ids)}`;
    await sql`delete from trades where manager_a in ${sql(ids)} or manager_b in ${sql(ids)}`;
  }
  await sql`delete from lot_events where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from sales where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from players where id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from managers where slot in (${SLOT_A}, ${SLOT_B})`;
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

try {
  await cleanup(); // in case a prior run died mid-test

  // --- 1. read real state first: whatever already exists must be well-formed.
  const before = await buildTradesPayload(sql, cfg);
  const [{ n: dbCountBefore }] = await sql`select count(*)::int as n from trades where voided = false`;
  report("payload.count matches the count of non-voided trades in the DB (pre-fixture)", before.count === dbCountBefore, `${before.count} vs ${dbCountBefore}`);
  report(
    "every existing trade has managerA/managerB with slot+short",
    before.trades.every(
      (t) =>
        typeof t.managerA.slot === "number" && typeof t.managerA.short === "string" &&
        typeof t.managerB.slot === "number" && typeof t.managerB.short === "string",
    ),
  );
  report(
    "every existing trade's cash is coerced to a number",
    before.trades.every((t) => typeof t.cashAToB === "number" && typeof t.cashBToA === "number"),
  );
  report(
    "every moved player carries a webName",
    before.trades.every((t) =>
      [...t.playersAToB, ...t.playersBToA].every((p) => typeof p.webName === "string" && p.webName.length > 0),
    ),
  );
  report(
    "trades are ordered newest first (descending id)",
    before.trades.every((t, i, arr) => i === 0 || arr[i - 1].id > t.id),
  );

  // --- 2. set up a fixture trade (real write path: recordTrade) ------------
  const [existingState] = await sql`select * from app_state where id = 1`;
  if (!existingState) {
    await sql`insert into app_state (id) values (1)`;
    createdAppStateRow = true;
  } else {
    savedAppState = existingState;
  }

  const bottomTier = cfg.tiers[cfg.tiers.length - 1].tier;
  const [{ id: A }] = await sql`insert into managers (slot, short, display_order) values (${SLOT_A}, 'Manager 940', ${SLOT_A}) returning id`;
  const [{ id: B }] = await sql`insert into managers (slot, short, display_order) values (${SLOT_B}, 'Manager 941', ${SLOT_B}) returning id`;
  await sql`
    insert into players (id, code, web_name, team_short, position, fpl_price, tier)
    values (${P_MID}, ${P_MID}, 'Trades Test Mid', 'TST', 'MID', 5.0, ${bottomTier})
  `;
  await sql`insert into sales (player_id, manager_id, price, lot_no, phase) values (${P_MID}, ${A}, 500, 1, 1)`;
  await sql`update app_state set paused = false, phase = 1, current_player_id = null where id = 1`;

  const t = await recordTrade(sql, cfg, { managerA: A, managerB: B, playersAToB: [P_MID], cashBToA: 150, reason: "test", actor: ACTOR });
  report("fixture trade recorded", t.ok === true, t.ok ? `tradeId ${t.tradeId}` : t.message);
  const tradeId = t.ok ? t.tradeId : -1;

  // --- 3. the fixture trade shows up correctly in the payload ---------------
  const withFixture = await buildTradesPayload(sql, cfg);
  report("count increased by exactly one after the fixture trade", withFixture.count === before.count + 1, `${before.count} -> ${withFixture.count}`);
  const row = withFixture.trades.find((r) => r.id === tradeId);
  report("fixture trade is present in the payload", row != null);
  if (row) {
    report("fixture managerA is slot/short A", row.managerA.slot === SLOT_A && row.managerA.short === "Manager 940");
    report("fixture managerB is slot/short B", row.managerB.slot === SLOT_B && row.managerB.short === "Manager 941");
    report("fixture cashAToB is 0, cashBToA is 150 (both numbers)", row.cashAToB === 0 && row.cashBToA === 150);
    report("fixture playersAToB has the moved player with a webName", row.playersAToB.length === 1 && row.playersAToB[0].webName === "Trades Test Mid");
    report("fixture playersBToA is empty (nothing moved the other way)", row.playersBToA.length === 0);
    report("fixture player carries no value/price field (a trades read is never valued)", !("value" in row.playersAToB[0]) && !("price" in row.playersAToB[0]));
    report("fixture stage is set", typeof row.stage === "string" && row.stage.length > 0, row.stage);
    report("fixture createdAt is an ISO string", typeof row.createdAt === "string" && !Number.isNaN(Date.parse(row.createdAt)));
  }

  // --- 4. voiding excludes it -----------------------------------------------
  await sql`update trades set voided = true where id = ${tradeId}`;
  const afterVoid = await buildTradesPayload(sql, cfg);
  report("count drops back to the pre-fixture count once voided", afterVoid.count === before.count, `${afterVoid.count} vs ${before.count}`);
  report("voided fixture trade no longer appears in the payload", !afterVoid.trades.some((r) => r.id === tradeId));
} catch (err) {
  console.error("test-trades failed to run:", err.message);
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
