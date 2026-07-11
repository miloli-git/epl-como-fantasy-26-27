// Full test battery on a THROWAWAY scratch DB - the gate to run before any
// cutover to the real database. It never touches neondb (production) or
// como_demo (the demo): it creates a separate scratch database on the same
// Postgres instance, applies the schema, ingests the FPL pool, runs every
// suite against it, then drops it.
//
// Usage:
//   node --env-file=.env scripts/test-all.mjs
//     (--env-file must point at a maintenance DB on the instance, e.g. neondb;
//      the scratch DB is created beside it and dropped at the end.)
//
// Exit code is non-zero if ANY suite fails (or setup/ingest fails), so this is
// safe to wire into a pre-cutover check.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const base = process.env.DATABASE_URL;
if (!base) {
  console.error("DATABASE_URL not set. Run with --env-file=.env (a maintenance DB, e.g. neondb).");
  process.exit(1);
}

const SCRATCH = "como_test_battery";
const scratchUrl = new URL(base);
scratchUrl.pathname = "/" + SCRATCH;
const scratchEnv = { ...process.env, DATABASE_URL: scratchUrl.toString(), COMMISSIONER_TOKEN: "battery-token" };

/** Run a node script with the scratch env; return true on exit 0. */
function run(label, args, env = scratchEnv) {
  console.log(`\n=== ${label} ===`);
  const res = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  return res.status === 0;
}

const admin = postgres(base, { max: 1 });
let scratchSql; // opened after ingest for the between-suite reset (#50)
let allOk = true;
try {
  // Fresh scratch DB.
  await admin.unsafe(`drop database if exists ${SCRATCH} with (force)`);
  await admin.unsafe(`create database ${SCRATCH}`);
  console.log(`created scratch db "${SCRATCH}"`);

  // Schema + seed, then a real FPL ingest (write suites expect a populated pool).
  if (!run("db:setup", ["scripts/db-setup.mjs"])) throw new Error("db:setup failed");
  if (!run("ingest", ["scripts/ingest-fpl.mjs"])) throw new Error("ingest failed");

  // Cross-suite isolation (#50). The battery shares ONE scratch DB across all
  // suites, so residue from one suite (a stray sale, lot_event, trade, or a
  // fixture manager/player left by a mid-run failure) used to shift a later
  // suite's dynamically-computed expectations - most visibly the `lot` suite,
  // which derives nomination turns from whoever is in the DB and skips its
  // whole-pool sections when non-fixture sales exist. That made `lot` flake.
  // Fix: reset to the exact post-ingest baseline before every suite, so each
  // one starts from the same clean, populated, unfrozen pool.
  scratchSql = postgres(scratchUrl.toString(), { max: 1 });
  // Snapshot the post-ingest baseline (the 8 managers + the full player pool)
  // into helper tables, so the reset can restore EXACTLY that set - dropping any
  // fixture manager/player a suite added or left behind on a mid-run failure.
  await scratchSql`drop table if exists _battery_base_slots, _battery_base_players`;
  await scratchSql`create table _battery_base_slots   as select slot from managers`;
  await scratchSql`create table _battery_base_players as select id   from players`;
  // Data tables suites mutate; players/managers are the fixed baseline and are
  // NOT truncated (re-ingesting between suites would be slow). None of these is
  // referenced by a table outside the list, so no CASCADE is needed.
  const MUTABLE = "sales, lot_events, trades, trade_players, valuations, briefs, season_recap, audit_log";
  async function resetBaseline() {
    await scratchSql.unsafe(`truncate table ${MUTABLE} restart identity`);
    await scratchSql`delete from managers where slot not in (select slot from _battery_base_slots)`;
    await scratchSql`delete from players  where id   not in (select id   from _battery_base_players)`;
    await scratchSql`
      update app_state set
        phase = 1, paused = false, current_player_id = null, tv_view = 'block',
        reveal_until = null, nomination_turn = null, lot_queue = null,
        pool_frozen = false, version = version + 1
      where id = 1`;
  }

  // Every suite. Pure-logic suites (derive/club) do not need the DB but are
  // cheap and belong in the battery. DB suites run against the scratch DB.
  const suites = [
    ["derive (pure)", ["scripts/test-derive.mjs"]],
    ["club (pure)", ["scripts/test-club.mjs"]],
    ["schema", ["scripts/test-schema.mjs"]],
    ["config", ["scripts/test-config.mjs"]],
    ["ingest", ["scripts/test-ingest.mjs"]],
    ["state", ["scripts/test-state.mjs"]],
    ["players", ["scripts/test-players.mjs"]],
    ["player detail", ["scripts/test-player-detail.mjs"]],
    ["recap", ["scripts/test-recap.mjs"]],
    ["draft", ["scripts/test-draft.mjs"]],
    ["draft concurrency", ["scripts/test-draft-concurrency.mjs"]],
    ["corrections", ["scripts/test-corrections.mjs"]],
    ["trade", ["scripts/test-trade.mjs"]],
    ["trades", ["scripts/test-trades.mjs"]],
    ["lot", ["scripts/test-lot.mjs"]],
    ["full night", ["scripts/test-full-night.mjs"]],
  ];
  // Each suite runs from an identical clean baseline (fixes the documented
  // cross-suite CONTAMINATION flake, where residue shifted a later suite's
  // dynamic expectations). A suite that still fails is retried ONCE from a fresh
  // reset: a transient (e.g. a cloud-Postgres connection blip deep in the run)
  // passes on the retry; a real failure fails again deterministically. Retries
  // are logged, never hidden - a suite that only passes on retry is visible. (#50)
  const results = [];
  for (const [label, args] of suites) {
    await resetBaseline();
    let ok = run(label, args);
    let retried = false;
    if (!ok) {
      retried = true;
      console.log(`\n[retry] "${label}" failed; resetting to baseline and retrying once (transient-flake guard, #50)...`);
      await resetBaseline();
      ok = run(label, args);
      console.log(
        ok
          ? `[retry] "${label}" PASSED on retry - first result was a transient flake.`
          : `[retry] "${label}" FAILED again - this is a real failure.`,
      );
    }
    results.push([label, ok, retried]);
    if (!ok) allOk = false;
  }

  console.log("\n===================== BATTERY SUMMARY =====================");
  for (const [label, ok, retried] of results) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${retried ? (ok ? "  (passed on retry)" : "  (failed twice)") : ""}`);
  }
  console.log("===========================================================");
} catch (err) {
  console.error("battery aborted:", err.message);
  allOk = false;
} finally {
  // Close the between-suite connection before dropping the DB.
  if (scratchSql) {
    try { await scratchSql.end(); } catch { /* ignore */ }
  }
  try {
    await admin.unsafe(`drop database if exists ${SCRATCH} with (force)`);
    console.log(`dropped scratch db "${SCRATCH}"`);
  } catch (err) {
    console.error("failed to drop scratch db (drop it manually):", err.message);
  }
  await admin.end();
}

process.exit(allOk ? 0 : 1);
