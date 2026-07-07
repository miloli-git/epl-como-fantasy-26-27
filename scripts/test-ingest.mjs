// Tests THE INGEST GUARD (issue #5) without hitting the FPL API.
//
// Seeds a scratch scenario (fake player + manager + sale), spawns the real
// ingest script as a child process and asserts:
//   1. full ingest exits 1 while a sale exists;
//   2. full ingest exits 1 while pool_frozen = true (no sales);
//   3. --stats-only exits 0 in that frozen state (fed a local JSON fixture
//      via FPL_FIXTURE so no network is involved).
// Cleans up everything and restores pool_frozen to its pre-test value.
//
// Usage: node --env-file=.env scripts/test-ingest.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with `node --env-file=.env scripts/test-ingest.mjs`.");
  process.exit(1);
}

// Ids far outside the FPL range so we never collide with real rows.
const FAKE_PLAYER_ID = 999901;
const FAKE_MANAGER_SLOT = 999;

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

/** Run the ingest script as a child process; returns {status, stdout, stderr}. */
function runIngest(args, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    ["--env-file=.env", join("scripts", "ingest-fpl.mjs"), ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env, ...extraEnv } },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Minimal bootstrap-static fixture containing only the fake player, so a
// --stats-only run updates one existing row and never touches the network.
const fixture = {
  teams: [{ id: 999, short_name: "ZZZ", code: 9999 }],
  elements: [
    {
      id: FAKE_PLAYER_ID,
      code: 9999901,
      web_name: "Test Player",
      first_name: "Test",
      second_name: "Player",
      team: 999,
      element_type: 4,
      now_cost: 45,
      total_points: 7,
      goals_scored: 1,
      assists: 0,
      bonus: 0,
      starts: 2,
      minutes: 180,
      clean_sheets: 0,
      saves: 0,
      penalties_missed: 0,
      yellow_cards: 1,
      red_cards: 0,
      selected_by_percent: "0.3",
      birth_date: "2000-01-15",
    },
  ],
};

const fixtureDir = mkdtempSync(join(tmpdir(), "fpl-fixture-"));
const fixturePath = join(fixtureDir, "bootstrap.json");
writeFileSync(fixturePath, JSON.stringify(fixture));

const sql = postgres(url, { max: 1 });
let fakeManagerId = null;
// Captured pre-test value of app_state.pool_frozen; cleanup restores it verbatim.
let preFrozen = null;
// cleanup() is a no-op until the test has actually seeded fixtures, so the
// "real sales exist" abort path is structurally safe even if finally runs.
let seeded = false;

async function cleanup() {
  if (!seeded) return;
  await sql`delete from sales where player_id = ${FAKE_PLAYER_ID}`;
  if (fakeManagerId != null) {
    await sql`delete from managers where id = ${fakeManagerId}`;
  } else {
    await sql`delete from managers where slot = ${FAKE_MANAGER_SLOT}`;
  }
  await sql`delete from players where id = ${FAKE_PLAYER_ID}`;
  await sql`update app_state set pool_frozen = ${Boolean(preFrozen)} where id = 1`;
}

try {
  // Remember the pre-test frozen state so cleanup can restore it exactly.
  const [pre] = await sql`select pool_frozen from app_state where id = 1`;
  preFrozen = Boolean(pre?.pool_frozen);
  if (preFrozen) {
    console.log("note: pool_frozen was already true before the test; it will be restored to true afterwards.");
  }
  const [{ count: preSales }] = await sql`select count(*)::int as count from sales`;
  if (preSales > 0) {
    console.error(`ABORT: ${preSales} real sales already exist; refusing to run guard tests against live draft data.`);
    process.exit(1);
  }

  // Seed: fake player + manager + sale (pool not frozen).
  seeded = true;
  await sql`update app_state set pool_frozen = false where id = 1`;
  await sql`
    insert into players (id, code, web_name, position, fpl_price, tier)
    values (${FAKE_PLAYER_ID}, 9999901, 'Test Player', 'FWD', 4.5, 4)
    on conflict (id) do nothing`;
  const [mgr] = await sql`
    insert into managers (slot, short, display_order)
    values (${FAKE_MANAGER_SLOT}, 'Test Manager', ${FAKE_MANAGER_SLOT})
    on conflict (slot) do update set short = excluded.short
    returning id`;
  fakeManagerId = mgr.id;
  await sql`
    insert into sales (player_id, manager_id, price, lot_no, phase)
    values (${FAKE_PLAYER_ID}, ${fakeManagerId}, 10, 1, 1)
    on conflict (player_id) do nothing`;

  // 1. A sale exists, pool not frozen: full ingest must refuse with exit 1.
  const withSale = runIngest([]);
  check(
    "full ingest exits 1 while a sale exists",
    withSale.status === 1,
    `exit ${withSale.status}`,
  );
  check(
    "refusal message names the guard and the --stats-only flag",
    /INGEST REFUSED/.test(withSale.stderr) && /--stats-only/.test(withSale.stderr),
    withSale.stderr.trim().slice(0, 200),
  );

  // 2. No sales, pool frozen: full ingest must still refuse.
  await sql`delete from sales where player_id = ${FAKE_PLAYER_ID}`;
  await sql`update app_state set pool_frozen = true where id = 1`;
  const whenFrozen = runIngest([]);
  check(
    "full ingest exits 1 while pool_frozen = true",
    whenFrozen.status === 1 && /INGEST REFUSED/.test(whenFrozen.stderr),
    `exit ${whenFrozen.status}`,
  );

  // 3. Same frozen state: --stats-only must succeed (fixture, no network).
  const statsOnly = runIngest(["--stats-only"], { FPL_FIXTURE: fixturePath });
  check(
    "--stats-only exits 0 in the frozen state",
    statsOnly.status === 0,
    `exit ${statsOnly.status}: ${(statsOnly.stderr || statsOnly.stdout).trim().slice(0, 200)}`,
  );

  // ...and it must have updated stats without touching identity columns.
  const [after] = await sql`
    select pts, yellows, position, tier, fpl_price from players where id = ${FAKE_PLAYER_ID}`;
  check(
    "--stats-only updated the stat columns for the existing row",
    after?.pts === 7 && after?.yellows === 1,
    `pts=${after?.pts} yellows=${after?.yellows}`,
  );
  check(
    "--stats-only left position/tier/fpl_price untouched",
    after?.position === "FWD" && after?.tier === 4 && Number(after?.fpl_price) === 4.5,
    `position=${after?.position} tier=${after?.tier} fpl_price=${after?.fpl_price}`,
  );
} catch (err) {
  failures += 1;
  console.error("test run errored:", err.message);
} finally {
  try {
    await cleanup();
    if (seeded) {
      console.log(`cleanup done: fake rows removed, pool_frozen restored to ${Boolean(preFrozen)}.`);
    }
  } catch (err) {
    failures += 1;
    console.error("CLEANUP FAILED (manual attention needed):", err.message);
  }
  rmSync(fixtureDir, { recursive: true, force: true });
  await sql.end();
}

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failing check${failures === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log("RESULT: all PASS");
