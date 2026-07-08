// Draft-morning job (#29): generate the SEALED Claude valuations + morning
// briefs for every player, using the Claude API, and write them to the
// valuations + briefs tables. Run at pool freeze / draft morning.
//
// Usage (writes to whatever DATABASE_URL points at):
//   node --env-file=.env scripts/generate-valuations.mjs                 full run
//   node --env-file=.env scripts/generate-valuations.mjs --limit 6 --dry-run
//   node --env-file=.env scripts/generate-valuations.mjs --scope premium --briefs-only
// Flags: --dry-run, --limit N, --values-only, --briefs-only,
//        --scope all|premium (premium = tiers 1-3), --model <id>, --batch N
//
// SEALING: these values are read only on SOLD rows (structural in
// state-core / players-core), so the auction reveals them only at the hammer.
// This job writes to the DB - it never prints full values to a committable
// place and never lands values in the repo.
//
// ROBUSTNESS (CLAUDE.md: the auction must run fine WITHOUT this): a failing
// batch is logged and skipped, never aborts the run; API 429/5xx retry with
// backoff. The Messages API is called via fetch (no new npm dependency).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig, squadSize, minOpenBid } from "../lib/config-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DRY = has("--dry-run");
const LIMIT = val("--limit", null) ? parseInt(val("--limit", "0"), 10) : null;
const VALUES_ONLY = has("--values-only");
const BRIEFS_ONLY = has("--briefs-only");
const SCOPE = val("--scope", "all"); // all | premium
const MODEL = val("--model", "claude-opus-4-8"); // skill default; override for cost
const BATCH = parseInt(val("--batch", "15"), 10);

const dbUrl = process.env.DATABASE_URL;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!dbUrl) {
  console.error("DATABASE_URL not set. Run with --env-file pointing at the target DB.");
  process.exit(1);
}
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY not set (it lives in .env). Pass --env-file=.env.");
  process.exit(1);
}

// League economy context (from config) - the anchors the model prices against.
const localPath = join(root, "league.config.local.json");
const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : undefined;
const cfg = buildConfig(JSON.parse(readFileSync(join(root, "league.config.json"), "utf8")), local);
const nManagers = cfg.managers.length;
const slots = squadSize(cfg);
const totalMoney = cfg.budget * nManagers;
const totalSlots = slots * nManagers;
const avgPerPlayer = Math.round(totalMoney / totalSlots);

const sql = postgres(dbUrl, { max: 1 });
const dbName = (() => { try { return new URL(dbUrl).pathname.slice(1); } catch { return "?"; } })();

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    players: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          value: { type: "integer" },
          brief: { type: "array", items: { type: "string" } },
        },
        required: ["id", "value", "brief"],
      },
    },
  },
  required: ["players"],
};

const SYSTEM = [
  "You are an auction-valuation expert for a private English Premier League fantasy draft league.",
  "For each player you are given last season's stats and league context. Return a SEALED auction valuation",
  "in league dollars (a whole number) plus a short 'morning brief' of 2-3 punchy bullets (form, role, and the",
  "value angle a bidder should know). Prices must respect the league economy: premium, in-form, nailed-on",
  "starters command far more than rotation or backup players. Be decisive and realistic; spread values across",
  "the pool rather than clustering. Do not use em dashes or en dashes; use hyphens.",
].join(" ");

function economyBlurb() {
  const tierLine = cfg.tiers.map((t) => `T${t.tier} opens $${t.openBid}`).join(", ");
  return [
    `League economy: ${nManagers} managers, $${cfg.budget} budget each ($${totalMoney} total).`,
    `Each squad is ${slots} players (${cfg.squad.GK} GK, ${cfg.squad.DEF} DEF, ${cfg.squad.MID} MID, ${cfg.squad.FWD} FWD),`,
    `so ${totalSlots} players get sold and the average sold player goes for about $${avgPerPlayer}.`,
    `Minimum opening bid is $${minOpenBid(cfg)}. Tier opening bids: ${tierLine}.`,
    `A true elite (top-5 overall) can go for many multiples of the average; fringe players go near the minimum.`,
  ].join(" ");
}

function playerLine(p) {
  const num = (v) => (v == null ? "-" : v);
  return {
    id: p.id,
    name: p.web_name,
    team: p.team_short,
    pos: p.position,
    tier: p.tier,
    fplPrice: p.fpl_price == null ? null : Number(p.fpl_price),
    pts: num(p.pts),
    goals: num(p.goals),
    assists: num(p.assists),
    bonus: num(p.bonus),
    minutes: num(p.minutes),
    starts: num(p.starts),
    cleanSheets: num(p.clean_sheets),
    saves: num(p.saves),
    ownedPct: p.selected_by == null ? null : Number(p.selected_by),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One Messages API call for a batch; returns [{id,value,brief}] or throws. */
async function valuateBatch(players) {
  const body = {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    // Structured outputs: guarantees a schema-valid, parseable JSON response.
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [
      {
        role: "user",
        content:
          economyBlurb() +
          "\n\nValue every player in this list and write each a 2-3 bullet brief. " +
          "Return an object {players:[{id,value,brief}]} covering ALL of them.\n\n" +
          JSON.stringify(players.map(playerLine)),
      },
    ],
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`retryable HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
      if (data.stop_reason === "refusal") throw new Error("model refused this batch");
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.players)) throw new Error("no players array in response");
      return parsed.players;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(500 * attempt * attempt);
    }
  }
  throw lastErr;
}

const tally = { valued: 0, briefed: 0, batches: 0, failedBatches: 0, skipped: 0 };

try {
  console.log(
    `target db "${dbName}" | model ${MODEL} | scope ${SCOPE} | batch ${BATCH}` +
      (DRY ? " | DRY RUN (no writes)" : "") +
      (VALUES_ONLY ? " | values only" : "") +
      (BRIEFS_ONLY ? " | briefs only" : ""),
  );

  const tierFilter = SCOPE === "premium" ? sql`and tier is not null and tier <= 3` : sql``;
  let players = await sql`
    select id, web_name, team_short, position, tier, fpl_price, pts, goals, assists,
           bonus, minutes, starts, clean_sheets, saves, selected_by
    from players
    where 1 = 1 ${tierFilter}
    order by pts desc nulls last, id
  `;
  if (LIMIT) players = players.slice(0, LIMIT);
  console.log(`valuing ${players.length} players in ${Math.ceil(players.length / BATCH)} batches`);

  for (let i = 0; i < players.length; i += BATCH) {
    const chunk = players.slice(i, i + BATCH);
    const byId = new Map(chunk.map((p) => [p.id, p]));
    tally.batches++;
    let out;
    try {
      out = await valuateBatch(chunk);
    } catch (err) {
      tally.failedBatches++;
      console.log(`  batch ${tally.batches} FAILED (skipped): ${err.message}`);
      continue;
    }
    for (const row of out) {
      if (!byId.has(row.id)) continue; // ignore anything not in this batch
      const value = Number.isInteger(row.value) ? Math.max(1, row.value) : null;
      const brief = Array.isArray(row.brief)
        ? row.brief.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
        : [];
      if (!BRIEFS_ONLY && value != null) {
        if (!DRY) {
          await sql`
            insert into valuations (player_id, value, generated_at)
            values (${row.id}, ${value}, now())
            on conflict (player_id) do update set value = excluded.value, generated_at = now()
          `;
        }
        tally.valued++;
      }
      if (!VALUES_ONLY && brief.length) {
        if (!DRY) {
          await sql`
            insert into briefs (player_id, bullets, swept_at)
            values (${row.id}, ${sql.json(brief)}, now())
            on conflict (player_id) do update set bullets = excluded.bullets, swept_at = now()
          `;
        }
        tally.briefed++;
      }
    }
    console.log(`  batch ${tally.batches}/${Math.ceil(players.length / BATCH)} done (${out.length} returned)`);
  }

  console.log(
    `\nDONE: ${tally.valued} valued, ${tally.briefed} briefed, ` +
      `${tally.failedBatches}/${tally.batches} batches failed.` +
      (DRY ? " (dry run - nothing written)" : ""),
  );
} catch (err) {
  console.error("generate-valuations failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
