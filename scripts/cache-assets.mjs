// Cache player photos and club crests to public/assets/ so the board never
// depends on the venue wifi on the night (THE HYBRID board uses a big portrait
// plus a face thumbnail, and club crests). The Premier League CDN serves these
// at 2x the nominal path size: the "250x250" path returns a 500x500 PNG and
// "110x140" returns 220x280, so the TV spotlight portrait is genuinely 500px.
//
// Usage:
//   node --env-file=.env scripts/cache-assets.mjs           all players, both sizes + crests
//   node --env-file=.env scripts/cache-assets.mjs --gentle  same, slowest pacing (safest for the pre-flight full run)
//   node --env-file=.env scripts/cache-assets.mjs --demo    only current-lot + sold players (fast, for a demo)
//   node --env-file=.env scripts/cache-assets.mjs --sample  first 5 players + 5 crests (smoke test)
//   node --env-file=.env scripts/cache-assets.mjs --max 40  cap the player count (proving/partial runs)
// Pacing overrides (env): CACHE_CONCURRENCY, CACHE_PAUSE_MS, CACHE_COOLOFF_MS.
//
// Layout written:
//   public/assets/players/250/p{code}.png   big board portrait (500x500 from the CDN)
//   public/assets/players/110/p{code}.png   face thumbnail (220x280 from the CDN)
//   public/assets/badges/t{code}.png        club crest (200x200 from the CDN)
//   public/assets/silhouette.svg            neutral fallback (never a broken image)
//   public/assets/asset-cache-report.json   machine-readable run summary + missing list
//
// THE CDN RATE LIMIT (learned the hard way, 8 Jul): resources.premierleague.com
// is S3 behind CloudFront. A burst of ~1000+ requests trips a per-IP limit and
// the CDN then returns "403 AccessDenied" for EVERY request, including photos
// that exist, for a cool-off period. S3 also returns that SAME 403 for objects
// that genuinely do not exist (no ListBucket permission) - so a 403 is
// ambiguous between "no photo yet" and "you are being throttled", and the only
// trustworthy run is one paced gently enough never to trip the limit.
//
// This script therefore: paces gently by default; retries a 403 with backoff;
// on a run of consecutive 403s it assumes throttling and cools the whole pool
// off before resuming; and if a run shows the throttle signature (any cool-off,
// or a high 403 rate) it exits NON-ZERO so an unattended pre-flight run fails
// loudly instead of silently caching hundreds of silhouettes over real faces.
// A genuine 404 is tolerated (silhouette covers it) and does not fail the run.
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
const gentle = process.argv.includes("--gentle");
const maxArgIdx = process.argv.indexOf("--max");
const maxPlayers = maxArgIdx !== -1 ? Number.parseInt(process.argv[maxArgIdx + 1], 10) : null;
if (maxArgIdx !== -1 && (!Number.isInteger(maxPlayers) || maxPlayers <= 0)) {
  console.error("--max needs a positive whole number, e.g. --max 40.");
  process.exit(1);
}

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

// Gentle by default; --gentle is gentler still; env overrides win. The old
// defaults (5 / 60ms) tripped the CDN limit around the 1000th request.
const CONCURRENCY = Number(process.env.CACHE_CONCURRENCY) || (gentle ? 1 : 3);
const PAUSE_MS = Number(process.env.CACHE_PAUSE_MS) || (gentle ? 400 : 150);
const COOLOFF_MS = Number(process.env.CACHE_COOLOFF_MS) || 60000;
const MAX_ATTEMPTS = 4;
// Consecutive 403s that trip a global cool-off (assume throttling, not that
// this many players in a row genuinely lack a photo).
const THROTTLE_STREAK = 8;
// If the overall 403 rate across a real run is above this, the missing list is
// not trustworthy (throttle contamination) and the run fails.
const THROTTLE_RATE = 0.15;

const tally = {
  downloaded: 0,
  skipped: 0,
  missing404: [], // genuine "no object" (silhouette covers) - does not fail the run
  denied403: [],  // 403 after retries: missing-or-throttled, ambiguous
  failed: [],     // network / 5xx after retries - always fails the run
  coolOffs: 0,
};
// Shared throttle state across the worker pool.
let consec403 = 0;
let coolingOff = null; // a promise while the pool is paused

async function maybeCoolOff() {
  if (consec403 >= THROTTLE_STREAK && !coolingOff) {
    tally.coolOffs += 1;
    console.log(
      `WARNING: ${consec403} consecutive 403s - assuming CDN throttling. ` +
      `Cooling off ${Math.round(COOLOFF_MS / 1000)}s before resuming...`,
    );
    coolingOff = sleep(COOLOFF_MS).then(() => {
      consec403 = 0;
      coolingOff = null;
    });
  }
  if (coolingOff) await coolingOff;
}

async function download(jobUrl, dest, label) {
  if (existsSync(dest)) {
    tally.skipped += 1;
    return;
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await maybeCoolOff();
    try {
      const res = await fetch(jobUrl);
      if (res.status === 404) {
        consec403 = 0;
        tally.missing404.push(label);
        return;
      }
      if (res.status === 403) {
        consec403 += 1;
        // Honour Retry-After if the CDN sends one; else exponential backoff.
        const retryAfter = Number(res.headers.get("retry-after"));
        if (attempt < MAX_ATTEMPTS) {
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt);
          continue;
        }
        tally.denied403.push(label);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      consec403 = 0;
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
  let photoRows = sample ? players.slice(0, 5) : players;
  if (maxPlayers != null) photoRows = photoRows.slice(0, maxPlayers);
  const crestCodes = sample ? teamCodes.slice(0, 5) : teamCodes;

  const jobs = [
    ...photoRows.map((p) => ({ url: PHOTO_250(p.code), dest: join(dir250, `p${p.code}.png`), label: `250 p${p.code} (${p.web_name})` })),
    ...photoRows.map((p) => ({ url: PHOTO_110(p.code), dest: join(dir110, `p${p.code}.png`), label: `110 p${p.code} (${p.web_name})` })),
    ...crestCodes.map((c) => ({ url: CREST(c), dest: join(badgesDir, `t${c}.png`), label: `crest t${c}` })),
  ];

  console.log(
    `caching ${photoRows.length} players x2 sizes + ${crestCodes.length} crests` +
    (demo ? " (demo scope)" : sample ? " (sample)" : "") +
    ` at concurrency ${CONCURRENCY}, ${PAUSE_MS}ms pause; silhouette written`,
  );
  await runPool(jobs);

  const attempts = tally.downloaded + tally.missing404.length + tally.denied403.length + tally.failed.length;
  const rate403 = attempts > 0 ? tally.denied403.length / attempts : 0;
  const throttled = tally.coolOffs > 0 || (tally.denied403.length >= 5 && rate403 > THROTTLE_RATE);

  console.log(
    `done: ${tally.downloaded} downloaded, ${tally.skipped} cached, ` +
    `${tally.missing404.length} genuinely missing (404, silhouette covers), ` +
    `${tally.denied403.length} denied (403), ${tally.failed.length} failed, ${tally.coolOffs} cool-offs.`,
  );

  // Persist a machine-readable report so the missing list can be re-checked
  // near the freeze (the CDN publishes new-signing photos over the summer).
  const report = {
    generatedAt: new Date().toISOString(),
    concurrency: CONCURRENCY,
    pauseMs: PAUSE_MS,
    trustworthy: !throttled && tally.failed.length === 0,
    counts: {
      downloaded: tally.downloaded,
      cached: tally.skipped,
      missing404: tally.missing404.length,
      denied403: tally.denied403.length,
      failed: tally.failed.length,
      coolOffs: tally.coolOffs,
    },
    missing404: tally.missing404,
    denied403: tally.denied403,
    failed: tally.failed,
  };
  writeFileSync(join(assetsDir, "asset-cache-report.json"), JSON.stringify(report, null, 2));

  if (tally.failed.length > 0) {
    for (const f of tally.failed) console.log(`  - failed: ${f}`);
  }
  if (throttled) {
    console.log(
      `THROTTLED: ${tally.denied403.length} of ${attempts} requests were 403 ` +
      `(${(rate403 * 100).toFixed(0)}%)${tally.coolOffs ? ` and the pool cooled off ${tally.coolOffs}x` : ""}. ` +
      "The CDN rate-limited this run, so the missing list is NOT trustworthy " +
      "(real photos may be recorded as missing). Wait for the block to clear " +
      "(tens of minutes), then re-run with --gentle. Do NOT treat this run as the pre-flight cache.",
    );
  }
  // Fail the run on any hard failure OR the throttle signature. A clean run
  // with only genuine 404s exits 0.
  if (tally.failed.length > 0 || throttled) process.exitCode = 1;
} catch (err) {
  console.error("cache-assets failed:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
