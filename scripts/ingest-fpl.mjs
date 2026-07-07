// Pull the FPL player pool into the players table (wide shape).
// Source: https://fantasy.premierleague.com/api/bootstrap-static/ (public, no auth).
//
// Usage:
//   node --env-file=.env scripts/ingest-fpl.mjs               full ingest (refused once frozen/sold)
//   node --env-file=.env scripts/ingest-fpl.mjs --stats-only  refresh stat columns + ranks for EXISTING ids only
//   node --env-file=.env scripts/ingest-fpl.mjs --freeze      set app_state.pool_frozen = true, nothing else
//
// Ingest guard (issue #5): once the pool is frozen or any sale exists, a full
// ingest could change positions/tiers/prices mid-draft and corrupt quotas, so
// it is refused. --stats-only is the safe escape hatch.
//
// Testing hook: set FPL_FIXTURE to a local JSON file (bootstrap-static shape)
// to skip the network fetch.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig, tierFor, FPL_POSITION } from "../lib/config-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.");
  process.exit(1);
}

const args = process.argv.slice(2);
const statsOnly = args.includes("--stats-only");
const freeze = args.includes("--freeze");
const unknown = args.filter((a) => a !== "--stats-only" && a !== "--freeze");
if (unknown.length > 0) {
  console.error(`Unknown flag(s): ${unknown.join(", ")}. Supported: --stats-only, --freeze.`);
  process.exit(1);
}
if (statsOnly && freeze) {
  console.error("--stats-only and --freeze cannot be combined.");
  process.exit(1);
}

// Config, loaded the same way db-setup does (local override wins; never print names).
const base = JSON.parse(readFileSync(join(root, "league.config.json"), "utf8"));
const localPath = join(root, "league.config.local.json");
const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : undefined;
const config = buildConfig(base, local);

const API = "https://fantasy.premierleague.com/api/bootstrap-static/";

// Stat columns a --stats-only refresh is allowed to touch (plus the ranks).
const STAT_COLS = [
  "pts", "goals", "assists", "bonus", "starts", "minutes",
  "clean_sheets", "saves", "pens_missed", "yellows", "reds", "selected_by",
];

/** Integer age in whole years as of today, or null. */
function ageFrom(birthDate) {
  if (!birthDate || typeof birthDate !== "string") return null;
  const born = new Date(birthDate);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const beforeBirthday =
    now.getMonth() < born.getMonth() ||
    (now.getMonth() === born.getMonth() && now.getDate() < born.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 100 ? age : null;
}

/**
 * Standard competition ranking (ties share a rank; 1 = highest points).
 * Mutates each row, writing the rank into `key`.
 */
function assignRanks(rows, key) {
  const sorted = [...rows].sort((a, b) => b.pts - a.pts);
  let rank = 0;
  let prevPts = null;
  for (const [i, row] of sorted.entries()) {
    if (row.pts !== prevPts) {
      rank = i + 1;
      prevPts = row.pts;
    }
    row[key] = rank;
  }
}

async function fetchBootstrap() {
  const fixture = process.env.FPL_FIXTURE;
  if (fixture) {
    return JSON.parse(readFileSync(fixture, "utf8"));
  }
  const res = await fetch(API);
  if (!res.ok) {
    throw new Error(`FPL API ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Map bootstrap-static payload to wide player rows, ranks included. */
function mapPlayers(data) {
  const teamById = new Map(data.teams.map((t) => [t.id, t]));
  const rows = data.elements
    // GK/DEF/MID/FWD only; guard against non-player element types.
    .filter((e) => FPL_POSITION[e.element_type])
    .map((e) => {
      const team = teamById.get(e.team);
      const fplPrice = e.now_cost / 10;
      const selectedBy = Number.parseFloat(e.selected_by_percent);
      return {
        id: e.id,
        code: e.code,
        web_name: e.web_name,
        first_name: e.first_name,
        second_name: e.second_name,
        team_id: e.team,
        team_short: team?.short_name ?? String(e.team),
        team_code: team?.code ?? null,
        position: FPL_POSITION[e.element_type],
        fpl_price: fplPrice,
        pts: e.total_points,
        goals: e.goals_scored,
        assists: e.assists,
        bonus: e.bonus,
        starts: e.starts,
        minutes: e.minutes,
        clean_sheets: e.clean_sheets,
        saves: e.saves,
        pens_missed: e.penalties_missed,
        yellows: e.yellow_cards,
        reds: e.red_cards,
        selected_by: Number.isFinite(selectedBy) ? selectedBy : null,
        tier: tierFor(config, fplPrice),
        // Bio, best-effort: bootstrap carries birth_date in recent seasons.
        // Nationality and height are not in bootstrap; the board hides absent facts.
        age: ageFrom(e.birth_date),
        nationality: null,
        height_cm: null,
      };
    });

  assignRanks(rows, "overall_rank");
  for (const pos of ["GK", "DEF", "MID", "FWD"]) {
    assignRanks(rows.filter((r) => r.position === pos), "position_rank");
  }
  return rows;
}

const INSERT_COLS = [
  "id", "code", "web_name", "first_name", "second_name",
  "team_id", "team_short", "team_code", "position", "fpl_price",
  ...STAT_COLS,
  "tier", "age", "nationality", "height_cm",
  "overall_rank", "position_rank",
];

const sql = postgres(url, { max: 1 });

/** THE INGEST GUARD (issue #5): current lock state (pool_frozen or any sale). */
async function readGuard() {
  const [state] = await sql`select pool_frozen from app_state where id = 1`;
  const [{ count: salesCount }] = await sql`select count(*)::int as count from sales`;
  return {
    frozen: Boolean(state?.pool_frozen),
    salesCount,
    locked: Boolean(state?.pool_frozen) || salesCount > 0,
  };
}

function refuse(guard) {
  console.error(
    "INGEST REFUSED: the pool is locked " +
    `(pool_frozen = ${guard.frozen}, sales = ${guard.salesCount}). ` +
    "A full ingest could change positions, tiers, prices or ids mid-draft and corrupt quotas. " +
    "To refresh stats safely, run with --stats-only (updates stat columns and ranks for existing players only).",
  );
  process.exitCode = 1;
}

try {
  if (freeze) {
    await sql`
      update app_state
      set pool_frozen = true, version = version + 1
      where id = 1`;
    console.log("pool frozen: app_state.pool_frozen = true. Full ingest is now locked (use --stats-only for stat refreshes).");
  } else {
    // Read the guard before writing anything.
    const guard = await readGuard();
    if (guard.locked && !statsOnly) {
      refuse(guard);
    } else {
      const data = await fetchBootstrap();
      const rows = mapPlayers(data);

      if (statsOnly) {
        // Update ONLY stat columns + ranks, ONLY for ids already in the table.
        // Single set-based update; never inserts, never touches position/tier/price/id.
        // Payload keys, SET list and recordset shape all derive from STAT_COLS;
        // ranks and updated are handled separately.
        const payload = rows.map((r) => {
          const row = { id: r.id };
          for (const col of STAT_COLS) row[col] = r[col];
          row.overall_rank = r.overall_rank;
          row.position_rank = r.position_rank;
          return row;
        });
        // Identifiers come from the STAT_COLS literal above, never from input.
        const statSet = STAT_COLS.map((c) => `${c} = v.${c}`).join(", ");
        const statTypes = STAT_COLS
          .map((c) => `${c} ${c === "selected_by" ? "numeric" : "int"}`)
          .join(", ");
        const result = await sql`
          update players p set
            ${sql.unsafe(statSet)},
            overall_rank = v.overall_rank, position_rank = v.position_rank,
            updated = now()
          from jsonb_to_recordset(${sql.json(payload)}) as v(
            id int, ${sql.unsafe(statTypes)},
            overall_rank int, position_rank int)
          where p.id = v.id`;
        console.log(`stats-only refresh: updated ${result.count} existing players (of ${rows.length} fetched).`);
      } else {
        // Fetch-window race: a sale or freeze may have landed while the FPL
        // fetch was in flight, so re-check the guard right before the first upsert.
        const recheck = await readGuard();
        if (recheck.locked) {
          refuse(recheck);
        } else {
          // Full ingest: batched upserts, ~100 rows per statement.
          const CHUNK = 100;
          let n = 0;
          for (let i = 0; i < rows.length; i += CHUNK) {
            const chunk = rows.slice(i, i + CHUNK);
            await sql`
              insert into players ${sql(chunk, ...INSERT_COLS)}
              on conflict (id) do update set
                code = excluded.code, web_name = excluded.web_name,
                first_name = excluded.first_name, second_name = excluded.second_name,
                team_id = excluded.team_id, team_short = excluded.team_short,
                team_code = excluded.team_code, position = excluded.position,
                fpl_price = excluded.fpl_price,
                pts = excluded.pts, goals = excluded.goals, assists = excluded.assists,
                bonus = excluded.bonus, starts = excluded.starts, minutes = excluded.minutes,
                clean_sheets = excluded.clean_sheets, saves = excluded.saves,
                pens_missed = excluded.pens_missed, yellows = excluded.yellows,
                reds = excluded.reds, selected_by = excluded.selected_by,
                tier = excluded.tier, age = excluded.age,
                nationality = excluded.nationality, height_cm = excluded.height_cm,
                overall_rank = excluded.overall_rank, position_rank = excluded.position_rank,
                updated = now()`;
            n += chunk.length;
          }
          console.log(`ingested ${n} players from FPL`);
        }
      }
    }
  }
} catch (err) {
  console.error("ingest failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
