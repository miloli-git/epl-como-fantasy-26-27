// End-of-night archive (#32): snapshot each manager's leftover money (Y1) into
// season_recap, so the war-chest figure survives as a durable number of record
// even after later stages change the wallet. Idempotent: re-running upserts the
// current numbers for this season (safe to run again after a late correction).
//
// Rosters are NOT snapshotted here - they stay fully derivable from the
// sales/trades ledger. Only the per-manager leftover, which stops being
// re-derivable once February injections land, is recorded.
//
// Usage (run against the production DB at end of night, or a scratch DB to test):
//   node --env-file=.env scripts/archive-recap.mjs
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";
import { buildPlayersPayload } from "../lib/players-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with `node --env-file=<env> scripts/archive-recap.mjs`.");
  process.exit(1);
}

const base = JSON.parse(readFileSync(join(root, "league.config.json"), "utf8"));
const localPath = join(root, "league.config.local.json");
const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : undefined;
const cfg = buildConfig(base, local);
const season = cfg.season ?? "current";

const force = process.argv.includes("--force");

const sql = postgres(url, { max: 1 });
try {
  // Guard the "number of record" (#32/#33). buildPlayersPayload derives the
  // wallet across ALL stages (v1 does not yet derive per stage), so once a
  // later season-economy stage (waivers-1, auction-2, ...) has money rows, this
  // snapshot would no longer be the AUGUST leftover. Refuse to run in that case
  // so a stray re-run cannot overwrite August's frozen figure with a
  // waiver-inflated one. Pass --force only if you truly mean to.
  const [{ n: laterRows }] = await sql`
    select (
      (select count(*) from sales  where stage <> 'auction-1') +
      (select count(*) from trades where stage <> 'auction-1')
    )::int as n`;
  if (laterRows > 0 && !force) {
    console.error(
      `archive-recap refused: ${laterRows} money row(s) exist for a later stage ` +
        `(not 'auction-1'). Snapshotting now would overwrite the August leftover ` +
        `with a figure that includes later-stage spend. Use --force only if you ` +
        `are certain, or use the stage-aware archive once it exists.`,
    );
    process.exit(1);
  }

  const payload = await buildPlayersPayload(sql, cfg);
  const rows = payload.managers
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((m) => ({
      slot: m.slot,
      short: m.short,
      spent: m.spent,
      leftover: m.remaining,
      squadCount: m.squadPlayerIds.length,
    }));

  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        insert into season_recap (season, manager_slot, manager_short, spent, leftover, squad_count)
        values (${season}, ${r.slot}, ${r.short}, ${r.spent}, ${r.leftover}, ${r.squadCount})
        on conflict (season, manager_slot) do update set
          manager_short = excluded.manager_short,
          spent         = excluded.spent,
          leftover      = excluded.leftover,
          squad_count   = excluded.squad_count,
          created_at    = now()
      `;
    }
  });

  const total = rows.reduce((s, r) => s + r.leftover, 0);
  console.log(`archived season "${season}": ${rows.length} managers, total leftover ${total}`);
} catch (err) {
  console.error("archive-recap failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
