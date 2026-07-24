// Historical per-season stats ingest (#60/#61). Pulls up to five completed
// seasons from a VERSION-PINNED public dataset (Vaastav/Fantasy-Premier-League)
// and writes them to player_history, joined by the stable FPL `code`.
//
// This is a CONTROLLED build/freeze step, NOT a production request: it is run
// by hand near the pool freeze (like scripts/cache-assets.mjs), never from a
// page load. It only writes player_history + player_history_meta - it never
// touches players, sales, valuations or any auction path, so it is always safe
// to run and needs no ingest guard.
//
// Usage:
//   node --env-file=.env scripts/ingest-history.mjs
//   HISTORY_FIXTURE_DIR=/path node --env-file=.env scripts/ingest-history.mjs   (offline: read <dir>/<season>.csv)
//
// PROVENANCE: the exact source commit is pinned below and recorded in
// player_history_meta so the dataset is reproducible. Bump HISTORY_COMMIT to
// refresh against a newer snapshot.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { mapSeasonCsv } from "../lib/history-core.mjs";

// The five most recent completed seasons for the 26/27 draft, chronological.
const HISTORY_SEASONS = ["2021-22", "2022-23", "2023-24", "2024-25", "2025-26"];
const HISTORY_SOURCE = "vaastav/Fantasy-Premier-League";
const HISTORY_COMMIT = "f2090d378ebd1b0c3d14884770dde95f38c50a0d";
const rawUrl = (season) =>
  `https://raw.githubusercontent.com/${HISTORY_SOURCE}/${HISTORY_COMMIT}/data/${season}/players_raw.csv`;

const DB_COLS = [
  "code", "season", "position", "total_points", "minutes", "starts",
  "goals", "assists", "clean_sheets", "goals_conceded", "saves",
  "pens_saved", "pens_missed", "bonus", "yellows", "reds", "own_goals",
  "def_contribution", "xg", "xa", "xgi", "xgc",
  "influence", "creativity", "threat", "ict_index",
];

/** normalized (camelCase) history row -> DB (snake_case) row. */
function toDbRow(h) {
  return {
    code: h.code,
    season: h.season,
    position: h.position,
    total_points: h.totalPoints,
    minutes: h.minutes,
    starts: h.starts,
    goals: h.goals,
    assists: h.assists,
    clean_sheets: h.cleanSheets,
    goals_conceded: h.goalsConceded,
    saves: h.saves,
    pens_saved: h.pensSaved,
    pens_missed: h.pensMissed,
    bonus: h.bonus,
    yellows: h.yellows,
    reds: h.reds,
    own_goals: h.ownGoals,
    def_contribution: h.defContribution,
    xg: h.xg,
    xa: h.xa,
    xgi: h.xgi,
    xgc: h.xgc,
    influence: h.influence,
    creativity: h.creativity,
    threat: h.threat,
    ict_index: h.ictIndex,
  };
}

async function fetchSeasonCsv(season) {
  const dir = process.env.HISTORY_FIXTURE_DIR;
  if (dir) return readFileSync(join(dir, `${season}.csv`), "utf8");
  const res = await fetch(rawUrl(season));
  if (!res.ok) throw new Error(`fetch ${season} failed: HTTP ${res.status}`);
  return res.text();
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with `node --env-file=.env scripts/ingest-history.mjs`.");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
const tally = { seasons: 0, rows: 0, failedSeasons: [] };

try {
  console.log(
    `history ingest | source ${HISTORY_SOURCE}@${HISTORY_COMMIT.slice(0, 10)} | ` +
      `${HISTORY_SEASONS.length} seasons` + (process.env.HISTORY_FIXTURE_DIR ? " | FIXTURE dir" : ""),
  );

  for (const season of HISTORY_SEASONS) {
    try {
      const csv = await fetchSeasonCsv(season);
      // Dedupe by code (last wins): a multi-row INSERT ... ON CONFLICT throws
      // "cannot affect row a second time" if a code appears twice in one
      // statement, so collapse duplicate source rows before the upsert.
      const byCode = new Map();
      for (const r of mapSeasonCsv(csv, season).map(toDbRow)) byCode.set(r.code, r);
      const rows = [...byCode.values()];
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        await sql`
          insert into player_history ${sql(chunk, ...DB_COLS)}
          on conflict (code, season) do update set
            position = excluded.position, total_points = excluded.total_points,
            minutes = excluded.minutes, starts = excluded.starts,
            goals = excluded.goals, assists = excluded.assists,
            clean_sheets = excluded.clean_sheets, goals_conceded = excluded.goals_conceded,
            saves = excluded.saves, pens_saved = excluded.pens_saved,
            pens_missed = excluded.pens_missed, bonus = excluded.bonus,
            yellows = excluded.yellows, reds = excluded.reds, own_goals = excluded.own_goals,
            def_contribution = excluded.def_contribution,
            xg = excluded.xg, xa = excluded.xa, xgi = excluded.xgi, xgc = excluded.xgc,
            influence = excluded.influence, creativity = excluded.creativity,
            threat = excluded.threat, ict_index = excluded.ict_index`;
      }
      tally.seasons++;
      tally.rows += rows.length;
      console.log(`  ${season}: ${rows.length} players`);
    } catch (err) {
      // A failing season (fetch, parse OR insert) is logged and skipped, never
      // aborts the run - the player page degrades to whatever seasons loaded,
      // and the remaining seasons + the provenance write still complete.
      tally.failedSeasons.push(season);
      console.log(`  ${season}: FAILED (skipped) - ${err.message}`);
      continue;
    }
  }

  // Record provenance only when at least one season actually loaded, so the
  // meta row never claims a dataset that a fully-failed run never wrote. Record
  // the seasons that succeeded, not the full requested list.
  if (tally.seasons > 0) {
    const loaded = HISTORY_SEASONS.filter((s) => !tally.failedSeasons.includes(s));
    await sql`
      insert into player_history_meta (id, source, commit_sha, seasons, generated_at)
      values (1, ${HISTORY_SOURCE}, ${HISTORY_COMMIT}, ${loaded.join(",")}, now())
      on conflict (id) do update set
        source = excluded.source, commit_sha = excluded.commit_sha,
        seasons = excluded.seasons, generated_at = now()`;
  }

  console.log(
    `\nDONE: ${tally.rows} rows across ${tally.seasons}/${HISTORY_SEASONS.length} seasons` +
      (tally.failedSeasons.length ? ` (failed: ${tally.failedSeasons.join(", ")})` : ""),
  );
  if (tally.failedSeasons.length === HISTORY_SEASONS.length) process.exitCode = 1;
} catch (err) {
  console.error("ingest-history failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
