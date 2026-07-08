// Cache player photos and club crests to public/assets/ so the board never
// depends on the venue wifi on the night (THE HYBRID board uses a big 250x250
// portrait plus 110x140 face thumbnails, and club crests).
//
// Usage:
//   node --env-file=.env scripts/cache-assets.mjs           all players, both sizes + crests
//   node --env-file=.env scripts/cache-assets.mjs --demo    only current-lot + sold players (fast, for a demo)
//   node --env-file=.env scripts/cache-assets.mjs --sample  first 5 players + 5 crests (smoke test)
//
// Layout written:
//   public/assets/players/250/p{code}.png   big board portrait
//   public/assets/players/110/p{code}.png   face thumbnail (sold rail, ledger, console)
//   public/assets/badges/t{code}.png        club crest
//   public/assets/silhouette.svg            neutral fallback (never a broken image)
//
// Behaviour: skips files that already exist, retries with backoff, tolerates
// 404/403 "missing upstream" without failing (some players have no photo -> the
// board shows the silhouette), but exits 1 on a real network/5xx failure.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with `node --env-file=.env scripts/cache-assets.mjs`.");
  process.exit(1);
}

const sample = process.argv.includes("--sample");
const demo = process.argv.includes("--demo");

const PHOTO_250 = (code) =>
  `https://resources.premierleague.com/premierleague/photos/players/250x250/p${code}.png`;
const PHOTO_110 = (code) =>
  `https://resources.premierleague.com/premierleague/photos/players/110x140/p${code}.png`;
const CREST = (teamCode) =>
  `https://resources.premierleague.com/premierleague/badges/100/t${teamCode}@x2.png`;

const dir250 = join(root, "public", "assets", "players", "250");
const dir110 = join(root, "public", "assets", "players", "110");
const badgesDir = join(root, "public", "assets", "badges");
const assetsDir = join(root, "public", "assets");
for (const d of [dir250, dir110, badgesDir]) mkdirSync(d, { recursive: true });

// Neutral silhouette fallback (written once; the board points <img> onError here).
const SILHOUETTE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 250"><rect width="250" height="250" fill="#2a2f2b"/><g fill="#565c54"><circle cx="125" cy="98" r="46"/><path d="M40 250c0-52 38-84 85-84s85 32 85 84z"/></g></svg>`;
writeFileSync(join(assetsDir, "silhouette.svg"), SILHOUETTE);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONCURRENCY = 5;
const PAUSE_MS = 60;
const MAX_ATTEMPTS = 3;
const tally = { downloaded: 0, skipped: 0, missing: [], failed: [], forbidden: 0 };

async function download(jobUrl, dest, label) {
  if (existsSync(dest)) {
    tally.skipped += 1;
    return;
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(jobUrl);
      if (res.status === 404 || res.status === 403) {
        if (res.status === 403) tally.forbidden += 1;
        tally.missing.push(`${label} (HTTP ${res.status})`);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      tally.downloaded += 1;
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) tally.failed.push(`${label}: ${err.message}`);
      else await sleep(300 * attempt);
    }
  }
}

async function runPool(jobs) {
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      await download(job.url, job.dest, job.label);
      await sleep(PAUSE_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
}

const sql = postgres(url, { max: 1 });
try {
  // --demo: only the players the board actually shows now (current lot + sold).
  const players = demo
    ? await sql`
        select code, web_name, team_code from players
        where code is not null
          and (id = (select current_player_id from app_state where id = 1)
               or id in (select player_id from sales))
        order by id`
    : await sql`select code, web_name, team_code from players where code is not null order by id`;
  if (players.length === 0) {
    console.error("No players to cache (run the ingest, or seed a demo for --demo).");
    process.exit(1);
  }

  const teamCodes = [...new Set(players.map((p) => p.team_code).filter((c) => c != null))];
  const photoRows = sample ? players.slice(0, 5) : players;
  const crestCodes = sample ? teamCodes.slice(0, 5) : teamCodes;

  const jobs = [
    ...photoRows.map((p) => ({ url: PHOTO_250(p.code), dest: join(dir250, `p${p.code}.png`), label: `250 p${p.code} (${p.web_name})` })),
    ...photoRows.map((p) => ({ url: PHOTO_110(p.code), dest: join(dir110, `p${p.code}.png`), label: `110 p${p.code} (${p.web_name})` })),
    ...crestCodes.map((c) => ({ url: CREST(c), dest: join(badgesDir, `t${c}.png`), label: `crest t${c}` })),
  ];

  console.log(
    `caching ${photoRows.length} players x2 sizes + ${crestCodes.length} crests` +
    (demo ? " (demo scope)" : sample ? " (sample)" : "") + `; silhouette written`,
  );
  await runPool(jobs);

  console.log(
    `done: ${tally.downloaded} downloaded, ${tally.skipped} cached, ` +
    `${tally.missing.length} missing upstream (silhouette will cover), ${tally.failed.length} failed.`,
  );
  const attempts = tally.downloaded + tally.missing.length + tally.failed.length;
  if (tally.forbidden >= 3 && tally.forbidden / attempts > 0.2) {
    console.log(`WARNING: ${tally.forbidden}/${attempts} were HTTP 403 - possible CDN rate-limiting; re-run slower.`);
  }
  if (tally.failed.length > 0) {
    for (const f of tally.failed) console.log(`  - failed: ${f}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("cache-assets failed:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
