// End-to-end smoke test for the skeleton board + console pages against the
// BUILT app: starts `next start` on a random port, seeds a tiny auction via
// direct DB (fixture ids 996xxx, manager slots 960-961, following the
// test-lot.mjs pattern: app_state capture/restore, pre-clean, id high-water
// marks), then drives it over HTTP.
//
// PREREQ: the caller runs `npm run build` first (.next must exist).
// Usage:   node --env-file=.env scripts/test-ui.mjs
//
// What it proves, at the API level: the page shells render their testid
// scaffolding (the pages are client components - the HTML shell carries no
// live data), /api/state serves the seeded lot, /api/draft enforces auth
// (401) and legality (422 with a message), a legal sale bumps the version and
// sets the reveal, and DELETE /api/draft/latest restores the block. REAL
// browser two-tab propagation is the orchestrator's verify ritual, not here.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { buildConfig, openBidFor } from "../lib/config-core.mjs";
import { buildQueue } from "../lib/lot-core.mjs";

const root = process.cwd();
const url = process.env.DATABASE_URL;
const token = process.env.COMMISSIONER_TOKEN;
if (!url) {
  console.error(
    "DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.",
  );
  process.exit(1);
}
if (!token) {
  console.error("COMMISSIONER_TOKEN not set (see .env.example). Cannot test writes.");
  process.exit(1);
}
if (!existsSync(join(root, ".next", "BUILD_ID"))) {
  console.error("No production build found (.next/BUILD_ID missing). Run `npm run build` first.");
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

// Fixture ids well outside real FPL ranges. test-draft owns 999xxx,
// test-corrections 998xxx, test-lot 997xxx; this suite owns 996xxx and
// manager slots 960-961.
const ID_LO = 996000;
const ID_HI = 996999;
const P1 = 996101; // FWD tier 1 - the seeded lot on the block
const P2 = 996201; // MID tier 2
const P3 = 996202; // MID tier 2
const SLOT_A = 960;
const SLOT_B = 961;
const ACTOR = "test-ui";

const PORT = 3100 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}

// --- fixture management (test-lot.mjs pattern) --------------------------

let savedAppState = null;
let createdAppStateRow = false;
// High-water marks, captured BEFORE any cleanup call. While null (not yet
// captured) the id-range deletes are skipped entirely, so a cleanup can only
// ever remove fixture-range rows (player_id 996xxx) and this suite's
// sentinel audit rows - never pre-existing lot_events or audit history.
let lotEventsFloor = null;
let auditFloor = null;
const managerIds = {}; // slot -> id

async function cleanup() {
  await sql`delete from audit_log where actor = ${ACTOR}`;
  // HTTP writes in this run audit as 'commissioner'; remove by high-water mark.
  if (auditFloor != null) {
    await sql`delete from audit_log where id > ${auditFloor} and actor = 'commissioner'`;
  }
  if (lotEventsFloor != null) {
    await sql`delete from lot_events where id > ${lotEventsFloor}`;
  }
  await sql`delete from lot_events where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from sales where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from players where id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from managers where slot between ${SLOT_A} and ${SLOT_B}`;
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

// --- server management ---------------------------------------------------

let server = null;
let serverLog = "";

function startServer() {
  server = spawn(
    process.execPath,
    [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
}

function stopServer() {
  if (!server) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    server.kill("SIGTERM");
  }
  server = null;
}

async function waitForReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function getState() {
  const res = await fetch(`${BASE}/api/state`, { headers: { "Cache-Control": "no-store" } });
  return res.ok ? res.json() : null;
}

function authed(body, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  };
}

// --- run -----------------------------------------------------------------

try {
  // Capture BOTH high-water marks first, so no cleanup call (pre-clean
  // included) can ever delete pre-existing rows via the id-range deletes.
  const [{ floor }] = await sql`select coalesce(max(id), 0)::int as floor from lot_events`;
  lotEventsFloor = floor;
  const [{ afloor }] = await sql`select coalesce(max(id), 0)::int as afloor from audit_log`;
  auditFloor = afloor;

  await cleanup(); // pre-clean stale fixtures from a previous crashed run

  const [existingState] = await sql`select * from app_state where id = 1`;
  if (!existingState) {
    await sql`insert into app_state (id) values (1)`;
    createdAppStateRow = true;
  } else {
    savedAppState = existingState;
  }

  for (const slot of [SLOT_A, SLOT_B]) {
    const [m] = await sql`
      insert into managers (slot, short, display_order)
      values (${slot}, ${"UI M" + slot}, ${slot})
      returning id
    `;
    managerIds[slot] = m.id;
  }

  const players = [
    { id: P1, position: "FWD", fpl_price: 13.0, tier: 1 },
    { id: P2, position: "MID", fpl_price: 9.5, tier: 2 },
    { id: P3, position: "MID", fpl_price: 9.0, tier: 2 },
  ].map((p) => ({
    id: p.id, code: p.id, web_name: `UI ${p.id}`, team_short: "TST",
    position: p.position, fpl_price: p.fpl_price, tier: p.tier,
  }));
  await sql`insert into players ${sql(players, "id", "code", "web_name", "team_short", "position", "fpl_price", "tier")}`;

  // Freeze the pool via app_state, then buildQueue via lib/lot-core - but
  // ONLY on a DB with no real auction history (buildQueue rewrites the whole
  // queue and clears lot_events; lot_events are not restorable). Either way
  // the fixture lot is then pinned onto the block directly (restored from
  // the captured app_state row in finally).
  await sql`
    update app_state
    set pool_frozen = true, phase = 1, paused = false, tv_view = 'block',
        reveal_until = null, nomination_turn = null
    where id = 1
  `;
  const [{ n: nonFixtureSales }] = await sql`
    select count(*)::int as n from sales
    where player_id not between ${ID_LO} and ${ID_HI}
  `;
  const [{ n: nonFixtureEvents }] = await sql`
    select count(*)::int as n from lot_events
    where player_id is null or player_id not between ${ID_LO} and ${ID_HI}
  `;
  if (nonFixtureSales === 0 && nonFixtureEvents === 0) {
    const built = await buildQueue(sql, cfg, { actor: ACTOR });
    report(
      "buildQueue on the frozen pool succeeds",
      built.ok === true,
      built.ok ? `${built.queue.length} lots` : `${built.code}: ${built.message}`,
    );
  } else {
    console.log(
      `SKIP  buildQueue (${nonFixtureSales} non-fixture sales, ${nonFixtureEvents} ` +
        "non-fixture lot events exist; it would rewrite real draft state)",
    );
  }
  // Pin the fixture auction: P1 on the block, fixture-only queue.
  await sql`
    update app_state
    set current_player_id = ${P1}, lot_queue = ${sql.json([P1, P2, P3])}
    where id = 1
  `;

  startServer();
  const ready = await waitForReady();
  report("next start serves /api/state", ready, ready ? `port ${PORT}` : serverLog.slice(-500));
  if (!ready) throw new Error("server never became ready");

  // --- page shells (client components: scaffolding only, no live data) ---
  const boardRes = await fetch(`${BASE}/`);
  const boardHtml = await boardRes.text();
  report("GET / returns 200", boardRes.status === 200, `status ${boardRes.status}`);
  for (const tid of ["board-page", "poll-status", "version"]) {
    report(
      `board shell carries data-testid="${tid}"`,
      boardHtml.includes(`data-testid="${tid}"`),
    );
  }

  const consoleRes = await fetch(`${BASE}/console`);
  const consoleHtml = await consoleRes.text();
  report("GET /console returns 200", consoleRes.status === 200, `status ${consoleRes.status}`);
  for (const tid of ["console-page", "token-input", "price-input", "verdict", "record-sale", "poll-status"]) {
    report(
      `console shell carries data-testid="${tid}"`,
      consoleHtml.includes(`data-testid="${tid}"`),
    );
  }

  // --- state shows the seeded lot ---
  const s0 = await getState();
  report(
    "GET /api/state shows the seeded lot on the block",
    s0 && s0.currentLot && s0.currentLot.id === P1 && s0.currentLot.name === `UI ${P1}` &&
      s0.currentLot.openBid === openBidFor(cfg, 1),
    s0 ? `lot ${s0.currentLot?.id}, opens ${s0.currentLot?.openBid}` : "no state",
  );
  const v0 = s0 ? s0.version : -1;

  // --- draft auth + legality over HTTP ---
  const noAuth = await fetch(`${BASE}/api/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: P1, managerId: managerIds[SLOT_A], price: 50 }),
  });
  report("POST /api/draft without a token is 401", noAuth.status === 401, `status ${noAuth.status}`);

  const openBid = openBidFor(cfg, 1);
  const low = await fetch(
    `${BASE}/api/draft`,
    authed({ playerId: P1, managerId: managerIds[SLOT_A], price: openBid - 1 }),
  );
  const lowBody = await low.json();
  // The exact rejection text, derived from config (P1 is tier 1); this is
  // the message draft-core emits for below_open.
  const expectedLowMsg = `Below the Tier 1 opening bid ($${openBidFor(cfg, 1)}).`;
  report(
    "illegal price (below tier open) is 422 with the exact message",
    low.status === 422 && lowBody.ok === false && lowBody.message === expectedLowMsg,
    `status ${low.status}, message = "${lowBody.message}"`,
  );

  const sale = await fetch(
    `${BASE}/api/draft`,
    authed({ playerId: P1, managerId: managerIds[SLOT_A], price: openBid }),
  );
  const saleBody = await sale.json();
  report(
    "legal sale is 200 ok",
    sale.status === 200 && saleBody.ok === true,
    `status ${sale.status}`,
  );

  const s1 = await getState();
  report(
    "sale bumps the state version",
    s1 && s1.version > v0,
    `v${v0} -> v${s1?.version}`,
  );
  report(
    "sale sets the reveal (tvView 'reveal', reveal for the sold player)",
    s1 && s1.tvView === "reveal" && s1.reveal && s1.reveal.playerId === P1 &&
      s1.reveal.price === openBid,
    `tv ${s1?.tvView}, reveal player ${s1?.reveal?.playerId}`,
  );
  report(
    "the block advances to the next unsold fixture",
    s1 && s1.currentLot && s1.currentLot.id === P2,
    `lot ${s1?.currentLot?.id}`,
  );
  report(
    "the buyer's derived numbers reflect the sale",
    s1 && (() => {
      const m = s1.managers.find((x) => x.slot === SLOT_A);
      return m && m.spent === openBid && m.fills.FWD === 1 && m.squad.length === 1;
    })(),
    "slot 960 spent/fills/squad",
  );

  // --- undo restores ---
  const undo = await fetch(`${BASE}/api/draft/latest`, authed(undefined, "DELETE"));
  const undoBody = await undo.json();
  report(
    "DELETE /api/draft/latest undoes the sale",
    undo.status === 200 && undoBody.ok === true,
    `status ${undo.status}`,
  );
  const s2 = await getState();
  report(
    "undo restores the player to the block and bumps the version",
    s2 && s2.currentLot && s2.currentLot.id === P1 && s2.version > (s1?.version ?? -1) &&
      s2.recentSales.every((r) => r.playerId !== P1),
    `lot ${s2?.currentLot?.id}, v${s2?.version}`,
  );
} catch (err) {
  console.error("test-ui failed to run:", err);
  if (serverLog) console.error("--- server log tail ---\n" + serverLog.slice(-2000));
  failed = true;
} finally {
  stopServer();
  try {
    await cleanup();
  } catch (err) {
    console.error("cleanup failed:", err.message);
    failed = true;
  }
  await sql.end();
}

process.exit(failed ? 1 : 0);
