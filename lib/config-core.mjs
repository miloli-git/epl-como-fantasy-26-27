// Pure config logic: deep-merge + validation + derived helpers.
// Plain JS (with JSDoc types) so it can be imported from both the typed
// runtime loader (lib/config.ts) and plain node scripts/tests without a
// build step. No fs, no globals - everything is passed in.

/** @typedef {"GK" | "DEF" | "MID" | "FWD"} Position */

/**
 * @typedef {Object} Tier
 * @property {number} tier        1-based tier number, highest tier first
 * @property {number} minFplPrice band floor: price >= minFplPrice lands here
 * @property {number} openBid     minimum opening bid for the tier
 */

/**
 * @typedef {Object} LeagueConfig
 * @property {string} season
 * @property {string[]} managers
 * @property {number} budget
 * @property {Record<Position, number>} squad
 * @property {Tier[]} tiers
 * @property {number | null} bidIncrement
 * @property {number} valueBadgeThreshold
 * @property {number} scarcityThreshold
 * @property {number} pollMs
 * @property {number} revealMs
 */

/** FPL element_type -> our position code. */
export const FPL_POSITION = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

const POSITIONS = ["GK", "DEF", "MID", "FWD"];

/** @param {unknown} v */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** @param {unknown} v */
function isPositiveInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Deep-merge `override` onto `base` and return a NEW object (inputs are not
 * mutated). Plain objects merge recursively; arrays and scalars replace
 * wholesale - so a local `managers` array of real names replaces the
 * placeholder array entirely.
 *
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} override
 * @returns {Record<string, unknown>}
 */
export function deepMerge(base, override) {
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    // Prototype-pollution guard: never merge these keys.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(
        /** @type {Record<string, unknown>} */ (out[key]),
        /** @type {Record<string, unknown>} */ (value),
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** @param {string} msg @returns {never} */
function fail(msg) {
  throw new Error(`League config is invalid: ${msg}`);
}

/**
 * Validate a merged config. Throws a plain-English Error naming the problem
 * field; returns the config unchanged on success.
 *
 * @param {Record<string, unknown>} cfg
 * @returns {LeagueConfig}
 */
export function validateConfig(cfg) {
  // managers: non-empty string array
  const managers = cfg.managers;
  if (
    !Array.isArray(managers) ||
    managers.length === 0 ||
    !managers.every((m) => typeof m === "string" && m.trim() !== "")
  ) {
    fail("managers must be a non-empty array of manager names (strings).");
  }

  // budget: positive number
  if (typeof cfg.budget !== "number" || !(cfg.budget > 0)) {
    fail(
      `budget must be a positive number of auction dollars (got ${JSON.stringify(cfg.budget)}).`,
    );
  }

  // squad: exactly GK/DEF/MID/FWD, each a positive integer
  const squad = cfg.squad;
  if (!isPlainObject(squad)) {
    fail("squad must be an object with GK, DEF, MID and FWD slot counts.");
  }
  for (const pos of POSITIONS) {
    if (!(pos in squad)) fail(`squad is missing the ${pos} position.`);
    if (!isPositiveInt(squad[pos])) {
      fail(
        `squad.${pos} must be a positive whole number of slots (got ${JSON.stringify(squad[pos])}).`,
      );
    }
  }
  for (const key of Object.keys(squad)) {
    if (!POSITIONS.includes(key)) {
      fail(`squad has an unknown position "${key}" (only GK, DEF, MID, FWD are allowed).`);
    }
  }

  // tiers: non-empty, sorted by minFplPrice descending, last band at 0,
  // every openBid a positive integer and strictly descending with the tiers
  const tiers = cfg.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    fail("tiers must be a non-empty array of price bands.");
  }
  for (const [i, t] of tiers.entries()) {
    if (!isPlainObject(t)) fail(`tiers[${i}] must be an object.`);
    if (!isPositiveInt(t.tier)) {
      fail(`tiers[${i}].tier must be a positive whole number (got ${JSON.stringify(t.tier)}).`);
    }
    if (typeof t.minFplPrice !== "number" || t.minFplPrice < 0) {
      fail(
        `tiers[${i}].minFplPrice must be a number of at least 0 (got ${JSON.stringify(t.minFplPrice)}).`,
      );
    }
    if (!isPositiveInt(t.openBid)) {
      fail(
        `tiers[${i}].openBid must be a positive whole number of dollars (got ${JSON.stringify(t.openBid)}).`,
      );
    }
  }
  for (let i = 1; i < tiers.length; i++) {
    if (!(tiers[i].minFplPrice < tiers[i - 1].minFplPrice)) {
      fail(
        "tiers must be sorted by minFplPrice from highest to lowest " +
          `(tier at position ${i + 1} has minFplPrice ${tiers[i].minFplPrice}, ` +
          `which is not below the previous band's ${tiers[i - 1].minFplPrice}).`,
      );
    }
  }
  for (let i = 1; i < tiers.length; i++) {
    if (!(tiers[i].openBid < tiers[i - 1].openBid)) {
      fail(
        "openBid must fall as the tiers get cheaper " +
          `(tier ${tiers[i].tier} has openBid ${tiers[i].openBid}, ` +
          `which is not below tier ${tiers[i - 1].tier}'s openBid of ${tiers[i - 1].openBid}).`,
      );
    }
  }
  if (tiers[tiers.length - 1].minFplPrice !== 0) {
    fail(
      "the last tier's minFplPrice must be 0 so every player falls into a band " +
        `(got ${tiers[tiers.length - 1].minFplPrice}).`,
    );
  }

  // bidIncrement: null (voice bidding) or a positive number
  if (cfg.bidIncrement !== null && cfg.bidIncrement !== undefined) {
    if (typeof cfg.bidIncrement !== "number" || !(cfg.bidIncrement > 0)) {
      fail(
        `bidIncrement must be null (voice bidding) or a positive number (got ${JSON.stringify(cfg.bidIncrement)}).`,
      );
    }
  }

  // remaining numeric knobs: positive numbers
  for (const key of ["valueBadgeThreshold", "scarcityThreshold", "pollMs", "revealMs"]) {
    if (typeof cfg[key] !== "number" || !(cfg[key] > 0)) {
      fail(`${key} must be a positive number (got ${JSON.stringify(cfg[key])}).`);
    }
  }

  return /** @type {LeagueConfig} */ (/** @type {unknown} */ (cfg));
}

/**
 * Merge an optional local override onto the base config, validate the result
 * and return it. Pure: neither input is mutated.
 *
 * @param {Record<string, unknown>} base   parsed league.config.json
 * @param {Record<string, unknown>} [local] parsed league.config.local.json, if present
 * @returns {LeagueConfig}
 */
export function buildConfig(base, local) {
  const merged = local ? deepMerge(base, local) : deepMerge(base, {});
  return validateConfig(merged);
}

/**
 * Parse a local-override JSON blob, failing LOUDLY on anything malformed.
 * @param {string} text @param {string} label where the blob came from
 * @returns {Record<string, unknown>}
 */
function parseOverride(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `League config override from ${label} is not valid JSON: ${err.message}. ` +
        "Refusing to start rather than silently fall back to placeholder names.",
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `League config override from ${label} must be a JSON object ` +
        `(got ${Array.isArray(parsed) ? "an array" : typeof parsed}).`,
    );
  }
  return parsed;
}

/**
 * Choose and parse the local roster override (issue #22). The real roster can
 * arrive two ways:
 *   - league.config.local.json on disk (dev / the draft-night machine), or
 *   - a LEAGUE_CONFIG_LOCAL env var holding the same JSON, for Vercel: it
 *     builds from the PUBLIC repo and cannot see the gitignored file, so
 *     without this the deployed board would show placeholder names.
 *
 * Precedence: the local FILE wins over the env var when both are present (a
 * dev on the draft machine keeps their file authoritative). The env var is
 * consulted only when there is no file. The base league.config.json is always
 * the fallback when neither is present.
 *
 * Malformed JSON in whichever source is chosen throws LOUDLY (never a silent
 * fall-back to placeholders): a broken real-roster file on draft night, or a
 * bad env var on Vercel, must fail at startup, not quietly publish
 * "Manager 1..8" to the room.
 *
 * @param {{localFileText?: string | null, envText?: string | null}} [sources]
 * @returns {{local: Record<string, unknown> | undefined, source: "file" | "env" | "none"}}
 */
export function selectLocalOverride({ localFileText, envText } = {}) {
  if (localFileText != null && String(localFileText).trim() !== "") {
    return {
      local: parseOverride(localFileText, "league.config.local.json"),
      source: "file",
    };
  }
  if (envText != null && String(envText).trim() !== "") {
    return {
      local: parseOverride(envText, "the LEAGUE_CONFIG_LOCAL env var"),
      source: "env",
    };
  }
  return { local: undefined, source: "none" };
}

/**
 * Total squad size per manager (sum of the position slot counts).
 * @param {LeagueConfig} cfg
 */
export function squadSize(cfg) {
  return POSITIONS.reduce((sum, pos) => sum + cfg.squad[/** @type {Position} */ (pos)], 0);
}

/**
 * The league-wide reserve: the lowest tier's opening bid.
 * @param {LeagueConfig} cfg
 */
export function minOpenBid(cfg) {
  return cfg.tiers[cfg.tiers.length - 1].openBid;
}

/**
 * Tier number for an FPL price. Bands are "price >= minFplPrice", scanned in
 * the config's descending order; the last band (minFplPrice 0) catches all.
 *
 * @param {LeagueConfig} cfg
 * @param {number} fplPrice
 * @returns {number}
 */
export function tierFor(cfg, fplPrice) {
  for (const t of cfg.tiers) {
    if (fplPrice >= t.minFplPrice) return t.tier;
  }
  // Unreachable with a validated config (last band is 0), but keep a sane
  // fallback for defence in depth.
  return cfg.tiers[cfg.tiers.length - 1].tier;
}

/**
 * Opening bid for a tier number.
 * @param {LeagueConfig} cfg
 * @param {number} tier
 * @returns {number}
 */
export function openBidFor(cfg, tier) {
  const band = cfg.tiers.find((t) => t.tier === tier);
  if (!band) {
    throw new Error(`League config has no tier ${tier} (tiers: ${cfg.tiers.map((t) => t.tier).join(", ")}).`);
  }
  return band.openBid;
}
