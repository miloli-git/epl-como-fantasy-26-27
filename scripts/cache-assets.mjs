// Cache player photos and club badges to public/assets/ so the board never
// depends on the venue wifi on the night.
//
// Usage:
//   node --env-file=.env scripts/cache-assets.mjs           all photos + badges
//   node --env-file=.env scripts/cache-assets.mjs --sample  first 5 photos + 5 distinct badges (testing)
//
// Behaviour: skips files that already exist, retries each download once,
// tolerates and reports 404/403 "missing upstream" without failing the run
// (some players have no photo), but exits 1 if any download failed after the
// retry (network error / 5xx). Polite to the CDN: ~5 concurrent downloads,
// short pause between requests.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.");
  process.exit(1);
}

const sample = process.argv.includes("--sample");

const PHOTO_URL = (code) =>
  `https://resources.premierleague.com/premierleague/photos/players/250x250/p${code}.png`;
const BADGE_URL = (teamCode) =>
  `https://resources.premierleague.com/premierleague/badges/100/t${teamCode}@x2.png`;

const playersDir = join(root, "public", "assets", "players");
const badgesDir = join(root, "public", "assets", "badges");
mkdirSync(playersDir, { recursive: true });
mkdirSync(badgesDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONCURRENCY = 5;
const PAUSE_MS = 60;

const tally = { downloaded: 0, skipped: 0, missing: [], failed: [], forbidden: 0 };

/**
 * Download one URL to dest. Retries with backoff (the CDN intermittently
 * answers 503 for objects it reports as 403/missing moments later).
 * Records 404/403 as missing upstream without throwing.
 */
const MAX_ATTEMPTS = 3;
async function download(jobUrl, dest, label) {
  if (existsSync(dest)) {
    tally.skipped += 1;
    return;
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(jobUrl);
      // The PL CDN answers 403 (not 404) for objects that do not exist, so
      // treat both as "no asset upstream" and move on. Caveat: 403 can ALSO
      // mean CDN rate-limiting; a run with many 403s should be re-run slower
      // (lower CONCURRENCY / higher PAUSE_MS). See the >20% warning below.
      if (res.status === 404 || res.status === 403) {
        if (res.status === 403) tally.forbidden += 1;
        tally.missing.push(`${label} (HTTP ${res.status})`);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(dest, buf);
      tally.downloaded += 1;
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        tally.failed.push(`${label}: ${err.message}`);
      } else {
        await sleep(300 * attempt);
      }
    }
  }
}

/** Run jobs with a small worker pool and a polite pause between requests. */
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
  const players = await sql`
    select code, web_name, team_code from players
    where code is not null
    order by id`;
  if (players.length === 0) {
    console.error("No players in the DB. Run the ingest first (npm run ingest).");
    process.exit(1);
  }

  const teamCodes = [...new Set(players.map((p) => p.team_code).filter((c) => c != null))];

  const photoRows = sample ? players.slice(0, 5) : players;
  const badgeCodes = sample ? teamCodes.slice(0, 5) : teamCodes;

  const jobs = [
    ...photoRows.map((p) => ({
      url: PHOTO_URL(p.code),
      dest: join(playersDir, `p${p.code}.png`),
      label: `photo p${p.code} (${p.web_name})`,
    })),
    ...badgeCodes.map((c) => ({
      url: BADGE_URL(c),
      dest: join(badgesDir, `t${c}@x2.png`),
      label: `badge t${c}`,
    })),
  ];

  console.log(
    `caching ${photoRows.length} photos + ${badgeCodes.length} badges` +
    (sample ? " (sample mode)" : ""),
  );
  await runPool(jobs);

  // Summary: "missing upstream" (404/403, tolerated, exit 0) is distinct from
  // "failed" (network/5xx after retry, exit 1).
  console.log(
    `done: ${tally.downloaded} downloaded, ${tally.skipped} already cached, ` +
    `${tally.missing.length} missing upstream (tolerated), ${tally.failed.length} failed (error).`,
  );
  if (tally.missing.length > 0) {
    for (const m of tally.missing) console.log(`  - missing: ${m}`);
  }
  // 403 can also mean CDN rate-limiting rather than a truly absent asset; if a
  // large share of attempts came back 403, suggest a slower re-run. The small
  // absolute floor stops a lone known-missing photo from tripping the warning.
  const attempts = tally.downloaded + tally.missing.length + tally.failed.length;
  if (tally.forbidden >= 3 && tally.forbidden / attempts > 0.2) {
    console.log(
      `WARNING: ${tally.forbidden} of ${attempts} attempts returned HTTP 403. ` +
      "This may be CDN rate-limiting, not missing assets. Re-run more slowly " +
      "(lower CONCURRENCY / higher PAUSE_MS) and check whether the 403s clear.",
    );
  }
  if (tally.failed.length > 0) {
    for (const f of tally.failed) console.log(`  - failed: ${f}`);
    console.error(`cache-assets: ${tally.failed.length} download(s) failed after retry.`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("cache-assets failed:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
