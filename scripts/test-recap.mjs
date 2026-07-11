// Integration test for the recap assembly (lib/recap-core.mjs, #32). Drives the
// exact core the /api/recap route serves, against the live DB it is pointed at.
//   node --env-file=<env> scripts/test-recap.mjs
//
// Good battery citizen (see #50): reads real state rather than seeding whole-pool
// fixtures, and the one thing it writes - a snapshot under a throwaway test
// season - is deleted in finally, so it cannot contaminate other suites.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";
import { buildPlayersPayload } from "../lib/players-core.mjs";
import { buildRecapPayload } from "../lib/recap-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with `node --env-file=<env> scripts/test-recap.mjs`.");
  process.exit(1);
}

const cfg = buildConfig(JSON.parse(readFileSync("league.config.json", "utf8")), undefined);
const sql = postgres(url, { max: 1 });
const TEST_SEASON = "recaptest-season-x";

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed = true;
}

try {
  await sql`delete from season_recap where season = ${TEST_SEASON}`; // in case a prior run died

  const players = await buildPlayersPayload(sql, cfg);
  const recap = await buildRecapPayload(sql, cfg);
  const soldIds = new Set(players.players.filter((p) => p.sold).map((p) => p.id));

  // 1. Live path: leftover mirrors the players-payload remaining, per manager.
  const remainingBySlot = new Map(players.managers.map((m) => [m.slot, m.remaining]));
  const squadCountBySlot = new Map(players.managers.map((m) => [m.slot, m.squadPlayerIds.length]));
  if (!recap.archived) {
    const leftoverOk = recap.managers.every((m) => m.leftover === remainingBySlot.get(m.slot));
    const squadOk = recap.managers.every((m) => m.squadCount === squadCountBySlot.get(m.slot));
    report("live leftover equals players-payload remaining per manager", leftoverOk);
    report("live squadCount equals owned player count per manager", squadOk);
  } else {
    report("live path skipped (a real archive already exists for this season)", true);
  }

  // 2. Totals add up.
  const sumLeft = recap.managers.reduce((s, m) => s + m.leftover, 0);
  const sumSpent = recap.managers.reduce((s, m) => s + m.spent, 0);
  report("totalLeftover equals the sum of manager leftovers", recap.totalLeftover === sumLeft, `${recap.totalLeftover} vs ${sumLeft}`);
  report("totalSpent equals the sum of manager spend", recap.totalSpent === sumSpent, `${recap.totalSpent} vs ${sumSpent}`);

  // 3. Awards select the extreme deltas among sold+valued players.
  const valued = players.players.filter((p) => p.sold && p.value != null && p.delta != null);
  const maxDelta = valued.reduce((mx, p) => (mx == null || p.delta > mx ? p.delta : mx), null);
  const minDelta = valued.reduce((mn, p) => (mn == null || p.delta < mn ? p.delta : mn), null);
  const { biggestOverpay, steal, fastestHammer } = recap.awards;
  report(
    "biggest overpay is the max positive delta (or null when none)",
    (maxDelta == null || maxDelta <= 0) ? biggestOverpay == null : biggestOverpay?.delta === maxDelta,
    `maxDelta=${maxDelta} award=${biggestOverpay?.delta}`,
  );
  report(
    "steal is the min negative delta (or null when none)",
    (minDelta == null || minDelta >= 0) ? steal == null : steal?.delta === minDelta,
    `minDelta=${minDelta} award=${steal?.delta}`,
  );

  // 4. SEALING: every award references a SOLD player (never an unsold value).
  const awardIds = [biggestOverpay, steal, fastestHammer].filter(Boolean).map((a) => a.playerId);
  report(
    "every award references a sold player (sealing not widened)",
    awardIds.every((id) => soldIds.has(id)),
    `award ids: ${awardIds.join(",")}`,
  );

  // 5. Fastest hammer, if present, is sold with a finite non-negative duration.
  if (fastestHammer) {
    report(
      "fastest hammer is a sold player with seconds >= 0",
      soldIds.has(fastestHammer.playerId) && Number.isFinite(fastestHammer.seconds) && fastestHammer.seconds >= 0,
      `seconds=${fastestHammer.seconds}`,
    );
  } else {
    report("fastest hammer null (no timed lots) - acceptable", true);
  }

  // 5b. Squads (#56): one per manager, sorted by slot, every listed player SOLD.
  const ORD = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
  const squadSlots = recap.squads.map((s) => s.slot);
  report(
    "one squad per manager, sorted by slot",
    recap.squads.length === players.managers.length &&
      squadSlots.every((v, i) => i === 0 || squadSlots[i - 1] < v),
    `slots: ${squadSlots.join(",")}`,
  );
  const countOk = recap.squads.every(
    (s) => s.players.length === s.squadCount && s.squadCount === squadCountBySlot.get(s.slot),
  );
  report("squadCount equals listed players equals owned count per manager", countOk);
  const allSquadIds = recap.squads.flatMap((s) => s.players.map((p) => p.id));
  report(
    "every squad player is a sold player (no unsold roster leak / seal not widened)",
    allSquadIds.every((id) => soldIds.has(id)),
  );
  report(
    "total squad players equals soldCount (each sold player in exactly one squad)",
    allSquadIds.length === recap.soldCount && new Set(allSquadIds).size === allSquadIds.length,
    `${allSquadIds.length} vs ${recap.soldCount}`,
  );
  const orderOk = recap.squads.every((s) =>
    s.players.every(
      (p, i, arr) =>
        i === 0 ||
        (ORD[arr[i - 1].position] ?? 9) < (ORD[p.position] ?? 9) ||
        ((ORD[arr[i - 1].position] ?? 9) === (ORD[p.position] ?? 9) &&
          (arr[i - 1].price ?? 0) >= (p.price ?? 0)),
    ),
  );
  report("squad players ordered by position then price desc", orderOk);
  report(
    "every squad player carries a FPL web_name for draft entry",
    recap.squads.every((s) => s.players.every((p) => typeof p.webName === "string" && p.webName.length > 0)),
  );
  const quotaSum = Object.values(recap.squad).reduce((a, b) => a + b, 0);
  report(
    "squad quotas present and sum to a positive squad size",
    recap.squad && quotaSum > 0 && ["GK", "DEF", "MID", "FWD"].every((k) => k in recap.squad),
    `quotas=${JSON.stringify(recap.squad)}`,
  );

  // 6. Archive path: a snapshot under a throwaway season is a NUMBER OF RECORD
  //    that overrides live derivation. Use sentinel leftovers unlike any live one.
  const slots = players.managers.map((m) => m.slot);
  for (const slot of slots) {
    const sentinel = 100000 + slot; // far outside any real leftover
    await sql`
      insert into season_recap (season, manager_slot, manager_short, spent, leftover, squad_count)
      values (${TEST_SEASON}, ${slot}, ${"M" + slot}, ${0}, ${sentinel}, ${0})
    `;
  }
  const archivedRecap = await buildRecapPayload(sql, { ...cfg, season: TEST_SEASON });
  report("archived flag true when a snapshot exists", archivedRecap.archived === true);
  report("archivedAt is set when archived", typeof archivedRecap.archivedAt === "string" && archivedRecap.archivedAt.length > 0);
  const sentinelsOk = archivedRecap.managers.every((m) => m.leftover === 100000 + m.slot);
  report("archived leftover comes from the snapshot, not live derivation", sentinelsOk);
} catch (err) {
  console.error("test-recap failed to run:", err.message);
  failed = true;
} finally {
  try {
    await sql`delete from season_recap where season = ${TEST_SEASON}`;
  } catch (err) {
    console.error("cleanup failed:", err.message);
    failed = true;
  }
  await sql.end();
}

process.exit(failed ? 1 : 0);
