// Verify the schema's core constraints against a live DB.
// Usage: node --env-file=.env scripts/test-schema.mjs
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

// Fixture ids chosen well outside real FPL/manager ranges.
const TEST_PLAYER_ID = 999901;
const TEST_MANAGER_SLOT = 999;

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed = true;
}

// Runs fn expecting a constraint error with the given code.
async function expectViolation(name, code, fn) {
  try {
    await fn();
    report(name, false, "insert unexpectedly succeeded");
  } catch (err) {
    report(name, err.code === code, err.code === code ? "" : `wrong error: ${err.code} ${err.message}`);
  }
}

// Captured before the bad-tv_view test so cleanup can restore live state
// even if the CHECK constraint were missing and the UPDATE went through.
let savedTvView = null;

async function cleanup() {
  await sql`delete from sales where player_id = ${TEST_PLAYER_ID}`;
  await sql`delete from players where id = ${TEST_PLAYER_ID}`;
  await sql`delete from managers where slot = ${TEST_MANAGER_SLOT}`;
  await sql`delete from app_state where id <> 1`;
  if (savedTvView !== null) {
    await sql`update app_state set tv_view = ${savedTvView} where id = 1`;
  }
}

try {
  await cleanup(); // in case a previous run died mid-way

  // Fixtures
  await sql`insert into players (id, web_name, position) values (${TEST_PLAYER_ID}, 'Test Player', 'MID')`;
  const [manager] = await sql`
    insert into managers (slot, short, display_order)
    values (${TEST_MANAGER_SLOT}, 'Test Manager', ${TEST_MANAGER_SLOT})
    returning id
  `;

  // 1. Exclusive ownership: second sale for the same player must fail.
  await sql`insert into sales (player_id, manager_id, price) values (${TEST_PLAYER_ID}, ${manager.id}, 10)`;
  await expectViolation(
    "sales: duplicate player_id rejected (unique violation)",
    UNIQUE_VIOLATION,
    () => sql`insert into sales (player_id, manager_id, price) values (${TEST_PLAYER_ID}, ${manager.id}, 20)`
  );

  // 2a. app_state singleton: a second row (id=2) must fail the CHECK.
  await expectViolation(
    "app_state: second row (id=2) rejected",
    CHECK_VIOLATION,
    () => sql`insert into app_state (id) values (2)`
  );

  // 2b. app_state: bad tv_view value must fail the CHECK.
  // Ensure the singleton row exists (otherwise the UPDATE matches nothing and
  // the test would silently "pass" for the wrong reason), and capture its
  // current tv_view so cleanup can restore it unconditionally.
  await sql`insert into app_state (id) values (1) on conflict (id) do nothing`;
  const [{ tv_view }] = await sql`select tv_view from app_state where id = 1`;
  savedTvView = tv_view;
  await expectViolation(
    "app_state: bad tv_view value rejected",
    CHECK_VIOLATION,
    () => sql`update app_state set tv_view = 'disco' where id = 1`
  );

  // 3. sales price CHECK: 0 must fail (delete the test sale first so the
  //    unique constraint doesn't mask the price check).
  await sql`delete from sales where player_id = ${TEST_PLAYER_ID}`;
  await expectViolation(
    "sales: price 0 rejected (check violation)",
    CHECK_VIOLATION,
    () => sql`insert into sales (player_id, manager_id, price) values (${TEST_PLAYER_ID}, ${manager.id}, 0)`
  );

  // 4. Stage tag (#31): a money-event row inserted without a stage defaults to
  //    'auction-1'. sales checked behaviourally; trades via its column default.
  await sql`insert into sales (player_id, manager_id, price) values (${TEST_PLAYER_ID}, ${manager.id}, 15)`;
  const [saleRow] = await sql`select stage from sales where player_id = ${TEST_PLAYER_ID}`;
  report("sales.stage defaults to auction-1 (#31)", saleRow?.stage === "auction-1", `got ${saleRow?.stage}`);
  await sql`delete from sales where player_id = ${TEST_PLAYER_ID}`;
  const [tradeStage] = await sql`
    select column_default, is_nullable from information_schema.columns
    where table_name = 'trades' and column_name = 'stage'`;
  report(
    "trades.stage exists, NOT NULL, defaults to auction-1 (#31)",
    tradeStage != null && tradeStage.is_nullable === "NO" && /auction-1/.test(tradeStage.column_default ?? ""),
    `got ${JSON.stringify(tradeStage)}`
  );
} catch (err) {
  console.error("test-schema failed to run:", err.message);
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
