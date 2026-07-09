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
let allOk = true;
try {
  // Fresh scratch DB.
  await admin.unsafe(`drop database if exists ${SCRATCH} with (force)`);
  await admin.unsafe(`create database ${SCRATCH}`);
  console.log(`created scratch db "${SCRATCH}"`);

  // Schema + seed, then a real FPL ingest (write suites expect a populated pool).
  if (!run("db:setup", ["scripts/db-setup.mjs"])) throw new Error("db:setup failed");
  if (!run("ingest", ["scripts/ingest-fpl.mjs"])) throw new Error("ingest failed");

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
    ["draft", ["scripts/test-draft.mjs"]],
    ["draft concurrency", ["scripts/test-draft-concurrency.mjs"]],
    ["corrections", ["scripts/test-corrections.mjs"]],
    ["trade", ["scripts/test-trade.mjs"]],
    ["lot", ["scripts/test-lot.mjs"]],
    ["full night", ["scripts/test-full-night.mjs"]],
  ];
  const results = [];
  for (const [label, args] of suites) {
    const ok = run(label, args);
    results.push([label, ok]);
    if (!ok) allOk = false;
  }

  console.log("\n===================== BATTERY SUMMARY =====================");
  for (const [label, ok] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log("===========================================================");
} catch (err) {
  console.error("battery aborted:", err.message);
  allOk = false;
} finally {
  try {
    await admin.unsafe(`drop database if exists ${SCRATCH} with (force)`);
    console.log(`dropped scratch db "${SCRATCH}"`);
  } catch (err) {
    console.error("failed to drop scratch db (drop it manually):", err.message);
  }
  await admin.end();
}

process.exit(allOk ? 0 : 1);
