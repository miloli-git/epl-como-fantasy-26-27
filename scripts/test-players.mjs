// Integration test for the /api/players assembly (lib/players-core.mjs) against
// a live DB - no dev server needed, it drives the same buildPlayersPayload the
// route serves.
//
// Usage: node --env-file=.env scripts/test-players.mjs
//   (point --env-file at a SCRATCH db, never neondb or a mid-demo como_demo.)
//
// Seeds three fake players (9999xx ids), a valuation for ALL THREE, then:
//   - UNSOLD: no sale, but a no_bid lot_event   -> value must stay sealed, NO BID
//   - SOLD:   sold to manager slot 1            -> value surfaces on its row
//   - TRADED: sold to slot 1 then traded to slot 2 -> owner follows the trade,
//             salary travels, value stays with the player
// Asserts the sealed-valuation rule STRUCTURALLY (no unsold player carries a
// value; the unsold value number appears nowhere), ownership-through-trades,
// the NO BID marker, and the per-manager summary invariants (claudeValue =
// sum of owned values; claudeDelta = claudeValue - spent; players<->managers
// agree on who owns what).

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";
import { buildPlayersPayload } from "../lib/players-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with `node --env-file=<scratch env> ...`.");
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

// Fixture ids well outside real FPL ranges.
const UNSOLD_ID = 999911;
const SOLD_ID = 999912;
const TRADED_ID = 999913;
// DANGLE: a valuation + a trade movement exist, but the player has NO sales row
// (simulating the last-line-of-defense scenario the read layer guards against -
// blocked upstream at the write layer today, but exercised here as a regression).
const DANGLE_ID = 999914;
// #44 display-name fixtures: two players share a web_name at different clubs
// (must disambiguate to "web_name (CLUB)"), plus an accented unique name (must
// pass through untouched).
const DUP_A_ID = 999915;
const DUP_B_ID = 999916;
const ACCENT_ID = 999917;
const DUP_NAME = "Zztestson"; // outside the real pool, so it only ever pairs here
const DUP_A_TEAM = "AAA";
const DUP_B_TEAM = "BBB";
const ACCENT_NAME = "Højlundson"; // accented + unique
const UNSOLD_VALUE = 987654; // distinctive: must appear NOWHERE in the payload
const DANGLE_VALUE = 876543; // distinctive: also must appear NOWHERE
const SOLD_VALUE = 500;
const TRADED_VALUE = 300;
const SALE_PRICE_SOLD = 601;
const SALE_PRICE_TRADED = 250;
const IDS = [UNSOLD_ID, SOLD_ID, TRADED_ID, DANGLE_ID, DUP_A_ID, DUP_B_ID, ACCENT_ID];

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}

// --- fixture management -------------------------------------------------
let createdManagerIds = [];
let createdTradeIds = [];

async function cleanup() {
  await sql`delete from trade_players where player_id in ${sql(IDS)}`;
  if (createdTradeIds.length) {
    await sql`delete from trades where id in ${sql(createdTradeIds)}`;
    createdTradeIds = [];
  }
  await sql`delete from lot_events where player_id in ${sql(IDS)}`;
  await sql`delete from sales where player_id in ${sql(IDS)}`;
  await sql`delete from valuations where player_id in ${sql(IDS)}`;
  await sql`delete from players where id in ${sql(IDS)}`;
  if (createdManagerIds.length) {
    await sql`delete from managers where id in ${sql(createdManagerIds)}`;
    createdManagerIds = [];
  }
}

/** Ensure a manager exists at `slot`; return its id (tracking any we create). */
async function ensureManager(slot) {
  let [m] = await sql`select id from managers where slot = ${slot}`;
  if (!m) {
    [m] = await sql`
      insert into managers (slot, short, display_order)
      values (${slot}, ${"Manager " + slot}, ${slot})
      returning id
    `;
    createdManagerIds.push(m.id);
  }
  return m.id;
}

try {
  await cleanup(); // in case a previous run died mid-way

  const m1 = await ensureManager(1);
  const m2 = await ensureManager(2);

  await sql`
    insert into players (id, code, web_name, team_short, team_code, position, fpl_price, tier, pts)
    values (${UNSOLD_ID}, ${UNSOLD_ID}, 'Test Unsold', 'TST', 1, 'MID', 9.5, 2, 111),
           (${SOLD_ID},   ${SOLD_ID},   'Test Sold',   'TST', 1, 'FWD', 12.5, 1, 222),
           (${TRADED_ID}, ${TRADED_ID}, 'Test Traded', 'TST', 1, 'DEF', 7.5, 3, 88),
           (${DANGLE_ID}, ${DANGLE_ID}, 'Test Dangle', 'TST', 1, 'MID', 8.0, 2, 50),
           (${DUP_A_ID},  ${DUP_A_ID},  ${DUP_NAME}, ${DUP_A_TEAM}, 1, 'DEF', 5.0, 4, 40),
           (${DUP_B_ID},  ${DUP_B_ID},  ${DUP_NAME}, ${DUP_B_TEAM}, 1, 'MID', 5.0, 4, 30),
           (${ACCENT_ID}, ${ACCENT_ID}, ${ACCENT_NAME}, 'ACC', 1, 'FWD', 6.0, 4, 20)
  `;
  // Valuations for ALL FOUR - only the sold/traded ones may ever surface.
  await sql`
    insert into valuations (player_id, value, generated_at)
    values (${UNSOLD_ID}, ${UNSOLD_VALUE}, now()),
           (${SOLD_ID}, ${SOLD_VALUE}, now()),
           (${TRADED_ID}, ${TRADED_VALUE}, now()),
           (${DANGLE_ID}, ${DANGLE_VALUE}, now())
  `;
  // UNSOLD: passed over with no bid (and never sold).
  await sql`insert into lot_events (player_id, event, phase) values (${UNSOLD_ID}, 'no_bid', 1)`;
  // Sales: SOLD to m1, TRADED originally to m1. DANGLE gets NO sale row.
  await sql`
    insert into sales (player_id, manager_id, price, lot_no, phase)
    values (${SOLD_ID}, ${m1}, ${SALE_PRICE_SOLD}, 9991, 1),
           (${TRADED_ID}, ${m1}, ${SALE_PRICE_TRADED}, 9992, 1)
  `;
  // Trade TRADED_ID from m1 to m2 (non-voided).
  const [trade] = await sql`
    insert into trades (manager_a, manager_b, cash_a_to_b, cash_b_to_a)
    values (${m1}, ${m2}, 0, 0) returning id
  `;
  createdTradeIds.push(trade.id);
  await sql`
    insert into trade_players (trade_id, player_id, from_manager, to_manager)
    values (${trade.id}, ${TRADED_ID}, ${m1}, ${m2})
  `;
  // DANGLE: a trade movement for a player with NO backing sale row (blocked at
  // the write layer today; here we forge it directly to prove the read layer's
  // last line of defense - resolveOwnership ignores a movement whose player has
  // no sale, so the player stays unsold and its valuation stays sealed).
  const [dangleTrade] = await sql`
    insert into trades (manager_a, manager_b, cash_a_to_b, cash_b_to_a)
    values (${m1}, ${m2}, 0, 0) returning id
  `;
  createdTradeIds.push(dangleTrade.id);
  await sql`
    insert into trade_players (trade_id, player_id, from_manager, to_manager)
    values (${dangleTrade.id}, ${DANGLE_ID}, ${m1}, ${m2})
  `;

  // --- the payload under test ---
  const payload = await buildPlayersPayload(sql, cfg);
  const byId = new Map(payload.players.map((p) => [p.id, p]));
  const mgr = new Map(payload.managers.map((m) => [m.slot, m]));

  // (a) STRUCTURAL SEAL: no unsold player carries a non-null value, anywhere.
  const leaked = payload.players.filter((p) => !p.sold && p.value != null);
  report(
    "no unsold player carries a value (structural sweep of all players)",
    leaked.length === 0,
    leaked.map((p) => `${p.id}=${p.value}`).join(", "),
  );

  // (b) neither the unsold nor the dangling player's valuation number appears
  //     ANYWHERE in the payload.
  const rawPayload = JSON.stringify(payload);
  report(
    "payload never contains the unsold or dangling valuation numbers",
    !rawPayload.includes(String(UNSOLD_VALUE)) && !rawPayload.includes(String(DANGLE_VALUE)),
  );

  // (b2) DANGLE (trade movement, valuation, but NO sale): read layer must treat
  //      it as unsold + sealed + unowned - the last line of defense.
  const d = byId.get(DANGLE_ID);
  const dOwned = payload.managers.some((m) => m.squadPlayerIds.includes(DANGLE_ID));
  report(
    "dangling player (movement, no sale) stays unsold, sealed and unowned",
    d && d.sold === false && d.value === null && d.ownerSlot === null && !dOwned,
    d ? `sold=${d.sold} value=${d.value} owner=${d.ownerSlot} inSquad=${dOwned}` : "missing",
  );

  // (c) UNSOLD row: unsold, no value, no owner, NO BID.
  const u = byId.get(UNSOLD_ID);
  report(
    "unsold fixture: sold=false, value=null, ownerless, noBid=true",
    u && u.sold === false && u.value === null && u.ownerShort === null &&
      u.ownerSlot === null && u.price === null && u.noBid === true,
    u ? `sold=${u.sold} value=${u.value} owner=${u.ownerSlot} noBid=${u.noBid}` : "missing",
  );

  // (d) SOLD row: value surfaces, owner is slot 1, verdict is v1-correct.
  const s = byId.get(SOLD_ID);
  report(
    "sold fixture: value + owner surface, salary correct",
    s && s.sold === true && s.value === SOLD_VALUE && s.ownerSlot === 1 &&
      s.price === SALE_PRICE_SOLD && s.noBid === false,
    s ? `value=${s.value} owner=${s.ownerSlot} price=${s.price}` : "missing",
  );
  report(
    "sold fixture verdict matches v1 logic (601 vs 500 -> OVERPAY +101)",
    s && s.verdict === "OVERPAY" && s.delta === SALE_PRICE_SOLD - SOLD_VALUE,
    s ? `verdict=${s.verdict} delta=${s.delta}` : "missing",
  );

  // (e) TRADED row: owner FOLLOWS the trade to slot 2, salary travels, value stays.
  const t = byId.get(TRADED_ID);
  report(
    "traded fixture: owner follows trade to slot 2, salary travels, value stays",
    t && t.sold === true && t.ownerSlot === 2 && t.price === SALE_PRICE_TRADED &&
      t.value === TRADED_VALUE,
    t ? `owner=${t.ownerSlot} price=${t.price} value=${t.value}` : "missing",
  );

  // (f) squad membership agrees with the trade: m2 owns TRADED, m1 owns SOLD only.
  const m1sq = mgr.get(1)?.squadPlayerIds ?? [];
  const m2sq = mgr.get(2)?.squadPlayerIds ?? [];
  report(
    "manager 1 owns SOLD but not TRADED; manager 2 owns TRADED",
    m1sq.includes(SOLD_ID) && !m1sq.includes(TRADED_ID) && m2sq.includes(TRADED_ID) &&
      !m2sq.includes(UNSOLD_ID),
    `m1=[${m1sq.join(",")}] m2=[${m2sq.join(",")}]`,
  );

  // (g) INVARIANT across every manager: claudeValue = sum of owned values;
  //     claudeDelta = claudeValue - spent; players<->managers agree on owner.
  let summaryOk = true;
  let summaryDetail = "";
  for (const m of payload.managers) {
    let sum = 0;
    let any = false;
    for (const pid of m.squadPlayerIds) {
      const p = byId.get(pid);
      // every id a manager claims must be a sold player owned by that manager
      if (!p || p.sold !== true || p.ownerSlot !== m.slot) {
        summaryOk = false;
        summaryDetail = `slot ${m.slot} claims ${pid} but row disagrees`;
      }
      if (p && p.value != null) {
        sum += p.value;
        any = true;
      }
    }
    const expected = any ? sum : null;
    if (m.claudeValue !== expected) {
      summaryOk = false;
      summaryDetail = `slot ${m.slot} claudeValue ${m.claudeValue} != ${expected}`;
    }
    const expectedDelta = expected == null ? null : expected - m.spent;
    if (m.claudeDelta !== expectedDelta) {
      summaryOk = false;
      summaryDetail = `slot ${m.slot} claudeDelta ${m.claudeDelta} != ${expectedDelta}`;
    }
  }
  report("per-manager summary invariants hold (value sum, delta, ownership agree)", summaryOk, summaryDetail);

  // (h) reverse consistency: every sold player is listed by exactly its owner.
  let ownershipOk = true;
  for (const p of payload.players) {
    if (!p.sold) continue;
    const owner = payload.managers.find((m) => m.slot === p.ownerSlot);
    if (!owner || !owner.squadPlayerIds.includes(p.id)) {
      ownershipOk = false;
      break;
    }
  }
  report("every sold player appears in exactly its owner's squad", ownershipOk);

  // (i) #44 DISPLAY NAMES: no two players share a rendered display name across
  //     the WHOLE payload - the guarantee that the room can never see the same
  //     nameplate twice and record a bid against the wrong player.
  const displaySeen = new Map();
  let dupDisplay = "";
  for (const p of payload.players) {
    const dn = p.displayName;
    if (dn == null) {
      dupDisplay = `player ${p.id} has null displayName`;
      break;
    }
    if (displaySeen.has(dn)) {
      dupDisplay = `"${dn}" shared by ${displaySeen.get(dn)} and ${p.id}`;
      break;
    }
    displaySeen.set(dn, p.id);
  }
  report("no two players share a rendered display name (whole payload)", dupDisplay === "", dupDisplay);

  // (j) the shared-web_name pair disambiguates to "web_name (CLUB)", and the
  //     raw web_name is still carried untouched on `name`.
  const da = byId.get(DUP_A_ID);
  const db = byId.get(DUP_B_ID);
  report(
    "duplicate web_name pair disambiguates by club, raw web_name preserved",
    da && db &&
      da.displayName === `${DUP_NAME} (${DUP_A_TEAM})` &&
      db.displayName === `${DUP_NAME} (${DUP_B_TEAM})` &&
      da.name === DUP_NAME && db.name === DUP_NAME,
    da && db ? `a="${da.displayName}" b="${db.displayName}"` : "missing",
  );

  // (k) a UNIQUE, accented name is untouched: displayName === raw web_name, and
  //     the accented characters survive intact (no mojibake, no club suffix).
  const acc = byId.get(ACCENT_ID);
  report(
    "unique accented name passes through unchanged (no club suffix, no mojibake)",
    acc && acc.displayName === ACCENT_NAME && acc.name === ACCENT_NAME,
    acc ? `displayName="${acc.displayName}"` : "missing",
  );
} catch (err) {
  console.error("test-players failed to run:", err.message);
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
