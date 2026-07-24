// Integration test for the /api/player/[id] assembly
// (lib/player-detail-core.mjs) against a live DB - no dev server needed, it
// drives the same buildPlayerDetailPayload the route serves.
//
// Usage: node --env-file=.env scripts/test-player-detail.mjs
//
// Seeds two fake players (999xxx ids) and a valuation for BOTH, then sells ONE.
// Asserts the sealed-valuation rule STRUCTURALLY for the UNSOLD player (its
// value must not appear ANYWHERE in that payload, and `sale` is null), that the
// SOLD player's now-unsealed value DOES surface on `sale` with the right
// verdict/owner, and that an unknown id returns null. Cleans up all fixtures.
//
// This is the #51 mirror of scripts/test-state.mjs: same distinctive-number
// leak scan, same fixture discipline.

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";
import { buildPlayerDetailPayload } from "../lib/player-detail-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });

// Same config path as the app (base + optional local override).
let local;
try {
  local = JSON.parse(readFileSync("league.config.local.json", "utf8"));
} catch {
  local = undefined;
}
const cfg = buildConfig(JSON.parse(readFileSync("league.config.json", "utf8")), local);

// Fixture ids well outside real FPL ranges.
const UNSOLD_ID = 999901;
const SOLD_ID = 999902;
const UNKNOWN_ID = 999903; // never inserted
const TRADED_ID = 999904; // sold to slot 1, then traded to slot 2
const UNSOLD_VALUE = 987654; // distinctive: must not appear anywhere in the unsold payload
const SOLD_VALUE = 500;
const SALE_PRICE = 601;
const TRADED_VALUE = 300;
const TRADED_PRICE = 250; // salary travels with the player through the trade
const MANAGER_SLOT = 1;
const MANAGER_SLOT_2 = 2;
// A filler code present in every window season, so the 5-season window is full
// even where the SOLD player (code == SOLD_ID) is absent (#60/#61 history test).
const HIST_FILLER_CODE = 999950;

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}

// Deep-scan an object tree for any key whose name smells like a valuation.
function findValuationKeys(node, path = "") {
  const hits = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => hits.push(...findValuationKeys(v, `${path}[${i}]`)));
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (/value|valuation/i.test(k)) hits.push(`${path}.${k}`);
      hits.push(...findValuationKeys(v, `${path}.${k}`));
    }
  }
  return hits;
}

// --- fixture management -------------------------------------------------

const createdManagerIds = []; // any manager slots we had to create
const createdTradeIds = []; // trades we forged for the traded fixture
const ALL_IDS = [UNSOLD_ID, SOLD_ID, TRADED_ID];

async function cleanup() {
  if (createdTradeIds.length > 0) {
    await sql`delete from trade_players where trade_id in ${sql(createdTradeIds)}`;
    await sql`delete from trades where id in ${sql(createdTradeIds)}`;
    createdTradeIds.length = 0;
  }
  await sql`delete from sales where player_id in ${sql(ALL_IDS)}`;
  await sql`delete from valuations where player_id in ${sql(ALL_IDS)}`;
  await sql`delete from player_history where code in ${sql([SOLD_ID, HIST_FILLER_CODE])}`;
  await sql`delete from players where id in ${sql(ALL_IDS)}`;
  if (createdManagerIds.length > 0) {
    await sql`delete from managers where id in ${sql(createdManagerIds)}`;
    createdManagerIds.length = 0;
  }
}

try {
  await cleanup(); // in case a previous run died mid-way

  // Managers slot 1 + 2 (create only if the seed hasn't run).
  async function ensureManager(slot, name) {
    let [m] = await sql`select id, slot, short from managers where slot = ${slot}`;
    if (!m) {
      [m] = await sql`
        insert into managers (slot, short, display_order)
        values (${slot}, ${name}, ${slot})
        returning id, slot, short
      `;
      createdManagerIds.push(m.id);
    }
    return m;
  }
  const manager = await ensureManager(MANAGER_SLOT, "Manager 1");
  const manager2 = await ensureManager(MANAGER_SLOT_2, "Manager 2");

  // Players: one to sell, one to leave unsold (the requested browse case), one
  // sold-then-traded (to prove owner resolution follows the trade).
  // SOLD carries distinctive extra-stat totals (#59) so we can assert the whole
  // last-season stat card surfaces, not just points.
  await sql`
    insert into players (id, code, web_name, team_short, position, fpl_price, tier, pts,
                         clean_sheets, saves, pens_missed, yellows, reds)
    values (${UNSOLD_ID}, ${UNSOLD_ID}, 'Test Unsold', 'TST', 'MID', 9.5, 2, 111,
            null, null, null, null, null),
           (${SOLD_ID},   ${SOLD_ID},   'Test Sold',   'TST', 'FWD', 12.5, 1, 222,
            7, 0, 1, 5, 2),
           (${TRADED_ID}, ${TRADED_ID}, 'Test Traded', 'TST', 'DEF', 7.5, 3, 88,
            null, null, null, null, null)
  `;
  // Valuations for ALL three - the whole point is that only sold/traded leak.
  await sql`
    insert into valuations (player_id, value, generated_at)
    values (${UNSOLD_ID}, ${UNSOLD_VALUE}, now()),
           (${SOLD_ID}, ${SOLD_VALUE}, now()),
           (${TRADED_ID}, ${TRADED_VALUE}, now())
  `;
  // Sell SOLD + TRADED to manager slot 1; leave UNSOLD unsold.
  await sql`
    insert into sales (player_id, manager_id, price, lot_no, phase)
    values (${SOLD_ID}, ${manager.id}, ${SALE_PRICE}, 999, 1),
           (${TRADED_ID}, ${manager.id}, ${TRADED_PRICE}, 998, 1)
  `;
  // Trade TRADED from slot 1 to slot 2 (non-voided): the detail page must name
  // slot 2 as the owner, with the salary travelling unchanged.
  const [trade] = await sql`
    insert into trades (manager_a, manager_b, cash_a_to_b, cash_b_to_a)
    values (${manager.id}, ${manager2.id}, 0, 0) returning id
  `;
  createdTradeIds.push(trade.id);
  await sql`
    insert into trade_players (trade_id, player_id, from_manager, to_manager)
    values (${trade.id}, ${TRADED_ID}, ${manager.id}, ${manager2.id})
  `;

  // --- (1) UNSOLD player: full seal ---
  const unsold = await buildPlayerDetailPayload(sql, cfg, UNSOLD_ID);
  report(
    "unsold payload is the unsold fixture",
    unsold?.player?.id === UNSOLD_ID,
    `player.id = ${unsold?.player?.id}`,
  );
  report("unsold payload has sale = null", unsold?.sale === null, `sale = ${JSON.stringify(unsold?.sale)}`);
  const hits = findValuationKeys(unsold);
  report(
    "unsold payload has no value/valuation key anywhere (deep scan)",
    hits.length === 0,
    hits.join(", "),
  );
  const rawUnsold = JSON.stringify(unsold);
  report(
    "unsold payload never contains the unsold player's valuation number",
    !rawUnsold.includes(String(UNSOLD_VALUE)),
  );
  // The spotlight fields the page needs are present (bio/stats), so the seal
  // is not achieved by starving the page of data.
  report(
    "unsold payload still carries the spotlight fields (name/stats)",
    unsold?.player?.displayName === "Test Unsold" && unsold?.player?.stats?.pts === 111,
    `displayName = ${unsold?.player?.displayName}, pts = ${unsold?.player?.stats?.pts}`,
  );

  // --- (2) SOLD player: full spotlight + sale result ---
  const sold = await buildPlayerDetailPayload(sql, cfg, SOLD_ID);
  report("sold payload is the sold fixture", sold?.player?.id === SOLD_ID);
  report(
    "sold payload's sale carries the now-unsealed value",
    sold?.sale?.value === SOLD_VALUE,
    `sale.value = ${sold?.sale?.value}`,
  );
  report(
    "sold sale verdict matches v1 logic (601 vs 500 -> OVERPAY +101)",
    sold?.sale?.verdict === "OVERPAY" && sold?.sale?.delta === SALE_PRICE - SOLD_VALUE,
    `verdict = ${sold?.sale?.verdict}, delta = ${sold?.sale?.delta}`,
  );
  report(
    "sold sale names the owner + price",
    sold?.sale?.ownerShort != null && sold?.sale?.price === SALE_PRICE,
    `ownerShort = ${sold?.sale?.ownerShort}, price = ${sold?.sale?.price}`,
  );
  // The base `player` object must NEVER carry the value, even when sold - value
  // lives only on `sale`.
  report(
    "sold payload's base player object carries no value key",
    findValuationKeys(sold?.player).length === 0,
    findValuationKeys(sold?.player).join(", "),
  );
  // (#59) The fuller last-season stat card surfaces from the stored columns.
  const ss = sold?.player?.stats;
  report(
    "sold payload carries the extra last-season stats (cs/saves/pens/cards)",
    ss?.cleanSheets === 7 && ss?.saves === 0 && ss?.pensMissed === 1 && ss?.yellows === 5 && ss?.reds === 2,
    `cs=${ss?.cleanSheets} saves=${ss?.saves} pens=${ss?.pensMissed} yel=${ss?.yellows} red=${ss?.reds}`,
  );

  // --- (3) TRADED player: owner resolves THROUGH the trade to slot 2 ---
  const traded = await buildPlayerDetailPayload(sql, cfg, TRADED_ID);
  report(
    "traded player's sale names the post-trade owner (slot 2), salary travels",
    traded?.sale?.ownerSlot === MANAGER_SLOT_2 && traded?.sale?.price === TRADED_PRICE,
    `ownerSlot = ${traded?.sale?.ownerSlot}, price = ${traded?.sale?.price}`,
  );
  report(
    "traded player's now-unsealed value stays with the player",
    traded?.sale?.value === TRADED_VALUE,
    `sale.value = ${traded?.sale?.value}`,
  );

  // --- (4) SOLD-THEN-VOIDED: a void is a hard DELETE of the sale row. The
  // valuation row stays behind; the payload must revert to sale=null and the
  // value must NOT reappear (structural seal survives a void). ---
  await sql`delete from sales where player_id = ${SOLD_ID}`;
  const voided = await buildPlayerDetailPayload(sql, cfg, SOLD_ID);
  report("voided sale reverts the payload to sale = null", voided?.sale === null, `sale = ${JSON.stringify(voided?.sale)}`);
  report(
    "voided player's valuation number does not reappear anywhere",
    !JSON.stringify(voided).includes(String(SOLD_VALUE)) && findValuationKeys(voided).length === 0,
  );

  // --- (5) unknown id -> null (route turns this into a 404) ---
  const missing = await buildPlayerDetailPayload(sql, cfg, UNKNOWN_ID);
  report("unknown player id returns null", missing === null, `got ${JSON.stringify(missing)}`);

  // --- (6) five-season history (#60/#61): code-joined, chronological, with
  // Not-in-FPL and N/A honesty. The filler code fills all five window seasons;
  // the SOLD player (code == SOLD_ID) is present in only four, skipping 2022-23. ---
  const WINDOW = ["2021-22", "2022-23", "2023-24", "2024-25", "2025-26"];
  for (const season of WINDOW) {
    await sql`insert into player_history (code, season, total_points) values (${HIST_FILLER_CODE}, ${season}, 1)`;
  }
  // 2022-23 deliberately omitted for SOLD -> "Not in FPL". xg is N/A in 2021-22
  // (pre expected-stats); def_contribution is N/A before 2025-26, set in 2025-26.
  await sql`
    insert into player_history (code, season, position, total_points, goals, def_contribution, xg)
    values (${SOLD_ID}, '2021-22', 'FWD', 180, 20, null, null),
           (${SOLD_ID}, '2023-24', 'FWD', 211, 18, null, 19.2),
           (${SOLD_ID}, '2024-25', 'FWD', 344, 29, null, 27.5),
           (${SOLD_ID}, '2025-26', 'FWD', 250, 21, 18, 22.1)
  `;
  const hp = await buildPlayerDetailPayload(sql, cfg, SOLD_ID);
  const h = hp?.history ?? [];
  report(
    "history has the full five-season window in chronological order",
    h.length === 5 && h.map((s) => s.season).join(",") === WINDOW.join(","),
    h.map((s) => s.season).join(","),
  );
  const bySeason = Object.fromEntries(h.map((s) => [s.season, s]));
  report(
    "missing season reads Not-in-FPL (2022-23)",
    bySeason["2022-23"]?.notInFpl === true && bySeason["2021-22"]?.notInFpl === false,
    `2022-23 notInFpl=${bySeason["2022-23"]?.notInFpl}`,
  );
  report(
    "present season carries the official total + counts",
    bySeason["2024-25"]?.totalPoints === 344 && bySeason["2024-25"]?.goals === 29,
    `2024-25 pts=${bySeason["2024-25"]?.totalPoints} g=${bySeason["2024-25"]?.goals}`,
  );
  report(
    "expected metric is N/A (null) before 2022-23, present after",
    bySeason["2021-22"]?.xg === null && bySeason["2023-24"]?.xg === 19.2,
    `2021-22 xg=${bySeason["2021-22"]?.xg}, 2023-24 xg=${bySeason["2023-24"]?.xg}`,
  );
  report(
    "defensive contribution is N/A (null) before 2025-26, set in 2025-26",
    bySeason["2023-24"]?.defContribution === null && bySeason["2025-26"]?.defContribution === 18,
    `2023-24 def=${bySeason["2023-24"]?.defContribution}, 2025-26 def=${bySeason["2025-26"]?.defContribution}`,
  );
} catch (err) {
  console.error("test-player-detail failed to run:", err.message);
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
