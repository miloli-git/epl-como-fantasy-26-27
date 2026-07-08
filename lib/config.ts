// Runtime league-config loader (repo issue #2).
//
// Reads league.config.json from the repo root with node fs, then - if a
// gitignored league.config.local.json exists (real roster / real numbers) -
// deep-merges it on top at RUNTIME. The fs read stays primary so the local
// override always applies; the build-time `import` of the base file below is
// a FALLBACK ONLY, for bundled deploys (Vercel serverless / next standalone)
// where the source json may not sit next to the compiled output.
//
// The pure merge + validate + derived helpers live in lib/config-core.mjs
// (plain JS with JSDoc types) so plain node scripts and tests can use the
// exact same logic without a build step; this module wraps them with types
// and adds the fs loading.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Build-time copy of the BASE config only, used when the fs read fails in a
// bundled deploy. The local override is gitignored, so it can never be
// bundled; it stays fs-only by definition.
import bundledBaseConfig from "../league.config.json";
import {
  buildConfig as buildConfigCore,
  minOpenBid as minOpenBidCore,
  openBidFor as openBidForCore,
  selectLocalOverride,
  squadSize as squadSizeCore,
  tierFor as tierForCore,
} from "./config-core.mjs";

export type Position = "GK" | "DEF" | "MID" | "FWD";

export interface Tier {
  /** 1-based tier number, highest tier first. */
  tier: number;
  /** Band floor: a player whose FPL price >= this lands in the band. */
  minFplPrice: number;
  /** Minimum opening bid for the tier. */
  openBid: number;
}

export interface LeagueConfig {
  season: string;
  sport: string;
  managers: string[];
  budget: number;
  squad: Record<Position, number>;
  /** Ordered highest minFplPrice first; last band's minFplPrice is 0. */
  tiers: Tier[];
  /** null = voice bidding, no enforced increment (v1). */
  bidIncrement: number | null;
  valueBadgeThreshold: number;
  scarcityThreshold: number;
  pollMs: number;
  revealMs: number;
}

const BASE_FILE = "league.config.json";
const LOCAL_FILE = "league.config.local.json";

/**
 * Locate the repo root: prefer process.cwd() (Next.js and npm scripts run
 * from the repo root), falling back to this module's parent directory so the
 * loader also works when a plain node script is run from elsewhere.
 */
function rootCandidates(): string[] {
  return [
    process.cwd(),
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  ];
}

function findRoot(): string {
  const candidates = rootCandidates();
  for (const dir of candidates) {
    if (existsSync(join(dir, BASE_FILE))) return dir;
  }
  throw new Error(
    `Cannot find ${BASE_FILE}. Looked in: ${candidates.join(" and ")}. ` +
      "Run from the repo root, or restore the file.",
  );
}

/**
 * Pure merge + validate (no fs): deep-merges `local` onto `base` (objects
 * merge recursively; arrays and scalars replace wholesale) and validates the
 * result, throwing a plain-English Error naming any bad field.
 */
export function buildConfig(
  base: Record<string, unknown>,
  local?: Record<string, unknown>,
): LeagueConfig {
  return buildConfigCore(base, local) as unknown as LeagueConfig;
}

let cached: LeagueConfig | null = null;

/** Load, merge, validate and cache the league config. */
export function getConfig(): LeagueConfig {
  if (cached) return cached;

  // Base: fs first (normal flow), bundled import only if the fs read fails
  // (e.g. Vercel serverless / next standalone where the json wasn't traced).
  let base: Record<string, unknown>;
  let localDirs: string[];
  try {
    const root = findRoot();
    base = JSON.parse(
      readFileSync(join(root, BASE_FILE), "utf8"),
    ) as Record<string, unknown>;
    localDirs = [root];
  } catch {
    base = bundledBaseConfig as unknown as Record<string, unknown>;
    // No discovered root; still try the usual candidates for a local override.
    localDirs = rootCandidates();
  }

  // Local override, two possible sources (issue #22):
  //   - league.config.local.json on disk (dev / draft machine), gitignored so
  //     never in the bundle; read here with fs, and
  //   - the LEAGUE_CONFIG_LOCAL env var (Vercel builds from the public repo and
  //     cannot see the file).
  // The file wins when both exist; malformed JSON in the chosen source throws
  // loudly. All of that precedence + loud-failure logic lives in the pure
  // selectLocalOverride so scripts/test-config.mjs tests the exact same rules.
  let localFileText: string | null = null;
  for (const dir of localDirs) {
    const localPath = join(dir, LOCAL_FILE);
    if (existsSync(localPath)) {
      localFileText = readFileSync(localPath, "utf8");
      break;
    }
  }
  const envText = process.env.LEAGUE_CONFIG_LOCAL ?? null;
  const { local } = selectLocalOverride({ localFileText, envText });

  cached = buildConfig(base, local);
  return cached;
}

/** Drop the cache and re-read from disk (for tests / config edits). */
export function reloadConfig(): LeagueConfig {
  cached = null;
  return getConfig();
}

/** Total squad size per manager (sum of the position slot counts). */
export function squadSize(cfg: LeagueConfig): number {
  return squadSizeCore(cfg);
}

/** The league-wide reserve: the lowest tier's opening bid. */
export function minOpenBid(cfg: LeagueConfig): number {
  return minOpenBidCore(cfg);
}

/**
 * Tier number for an FPL price. Bands are "price >= minFplPrice", scanned in
 * the config's descending order; the last band (minFplPrice 0) catches all.
 */
export function tierFor(cfg: LeagueConfig, fplPrice: number): number {
  return tierForCore(cfg, fplPrice);
}

/** Opening bid for a tier number; throws if the tier doesn't exist. */
export function openBidFor(cfg: LeagueConfig, tier: number): number {
  return openBidForCore(cfg, tier);
}

// FPL element_type -> our position code
export const FPL_POSITION: Record<number, Position> = {
  1: "GK",
  2: "DEF",
  3: "MID",
  4: "FWD",
};
