// Pure derivation logic: ownership, per-manager money/slot maths, pool
// counts, scarcity alerts and value-grading tertiles. Plain JS (with JSDoc
// types) so plain node scripts and tests can use the exact same logic without
// a build step; lib/derive.ts wraps it with TypeScript types.
//
// No DB, no fs, no globals - everything is passed in.

import { minOpenBid, squadSize } from "./config-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */
/** @typedef {"GK" | "DEF" | "MID" | "FWD"} Position */

export const POSITIONS = ["GK", "DEF", "MID", "FWD"];

/**
 * @typedef {Object} OwnedPlayer
 * @property {number} playerId
 * @property {number} managerId
 * @property {number} price     the salary the player carries
 * @property {Position} position
 */

/**
 * @typedef {Object} TradeMovement  one player leg of a non-voided trade
 * @property {number} playerId
 * @property {number} fromManager
 * @property {number} toManager
 * @property {number} seq  chronological order key (trade created order; a
 *                         higher seq happened later). Movements are applied in
 *                         ascending seq so the LATEST movement wins.
 */

/**
 * Resolve current ownership from raw rows, folding in trade movements.
 *
 * Sales rows are DELETED on void (see db/schema.sql), so every sales row that
 * exists is a current ownership and the sale price is the salary the player
 * carries. Trades then MOVE that ownership without changing the salary: the
 * salary travels with the player (PRD - "trade a $1,000 player away and
 * $1,000 comes off your spend and onto theirs"). Trade CASH is separate and is
 * NOT handled here - see tradeCashByManager, folded into spend by deriveManager.
 *
 * For each sold player the current owner is the `toManager` of the latest
 * (highest-seq) movement for that player, or the original buyer if the player
 * was never traded. Movements are applied in ascending seq so a chain
 * A->B then B->C lands on C. Callers pass ONLY non-voided movements (voided
 * trades are filtered out before this point). A movement for a player with no
 * sales row is ignored (you cannot own, or trade, an unsold player).
 *
 * @param {Array<{playerId: number, managerId: number, price: number, position: Position}>} saleRows
 * @param {TradeMovement[]} [tradeMovements]
 * @returns {OwnedPlayer[]}
 */
export function resolveOwnership(saleRows, tradeMovements = []) {
  /** @type {Map<number, OwnedPlayer>} playerId -> current ownership */
  const owned = new Map();
  for (const s of saleRows) {
    owned.set(s.playerId, {
      playerId: s.playerId,
      managerId: s.managerId,
      price: s.price,
      position: s.position,
    });
  }
  // Apply movements oldest-first so the newest movement decides the owner.
  const ordered = [...tradeMovements].sort((a, b) => a.seq - b.seq);
  for (const mv of ordered) {
    const cur = owned.get(mv.playerId);
    if (!cur) continue; // no sale for this player: nothing to move
    cur.managerId = mv.toManager; // salary (cur.price) travels unchanged
  }
  return [...owned.values()];
}

/**
 * Net trade cash per manager, in SPEND terms: a positive number means the
 * manager has paid out more cash than they took in across all their
 * non-voided trades, so it adds to spend (and lowers remaining). Cash the
 * manager received nets negative (raises remaining). Managers not party to any
 * trade are simply absent from the map (treated as 0 by deriveManager).
 *
 * Per trade between A and B: A's spend delta is (cashAToB - cashBToA); B's is
 * the mirror. This is the "cash settles differences" half of a trade; the
 * player-salary half is handled by resolveOwnership.
 *
 * @param {Array<{managerA: number, managerB: number, cashAToB: number, cashBToA: number}>} tradeRows
 * @returns {Record<number, number>}
 */
export function tradeCashByManager(tradeRows) {
  /** @type {Record<number, number>} */
  const net = {};
  for (const t of tradeRows) {
    const aOut = (t.cashAToB || 0) - (t.cashBToA || 0);
    net[t.managerA] = (net[t.managerA] || 0) + aOut;
    net[t.managerB] = (net[t.managerB] || 0) - aOut;
  }
  return net;
}

/**
 * @typedef {Object} ManagerDerived
 * @property {number} spent
 * @property {number} remaining
 * @property {Record<Position, number>} fills
 * @property {number} openSlots
 * @property {boolean} squadComplete
 * @property {number | null} maxBid  null when squad is complete
 */

/**
 * Derive one manager's money and slot numbers from the players they own.
 *
 * maxBid reserves the league-wide minimum opening bid for every OTHER open
 * slot: maxBid = remaining - minOpenBid * (openSlots - 1). Null when the
 * squad is complete (openSlots <= 0).
 *
 * `cashOut` is the manager's net trade cash in spend terms (see
 * tradeCashByManager): positive adds to spend, negative (cash received) lifts
 * remaining. Salaries of owned players already reflect trades because
 * resolveOwnership moved ownership with the salary attached.
 *
 * @param {LeagueConfig} cfg
 * @param {OwnedPlayer[]} owned  the rows belonging to this manager
 * @param {number} [cashOut]     net trade cash paid out (spend terms), default 0
 * @returns {ManagerDerived}
 */
export function deriveManager(cfg, owned, cashOut = 0) {
  const spent = owned.reduce((sum, p) => sum + p.price, 0) + cashOut;
  const remaining = cfg.budget - spent;
  /** @type {Record<string, number>} */
  const fills = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of owned) fills[p.position] += 1;
  const openSlots = squadSize(cfg) - owned.length;
  const squadComplete = openSlots <= 0;
  const maxBid = squadComplete
    ? null
    : remaining - minOpenBid(cfg) * (openSlots - 1);
  return { spent, remaining, fills, openSlots, squadComplete, maxBid };
}

/**
 * Derive every manager. Managers with no purchases still get a full row.
 *
 * @param {LeagueConfig} cfg
 * @param {Array<{id: number, slot: number, short: string}>} managers
 * @param {OwnedPlayer[]} ownership  output of resolveOwnership
 * @param {Record<number, number>} [cashByManager]  output of tradeCashByManager
 * @returns {Array<{managerId: number, slot: number, short: string} & ManagerDerived>}
 */
export function deriveManagers(cfg, managers, ownership, cashByManager = {}) {
  return managers.map((m) => {
    const owned = ownership.filter((o) => o.managerId === m.id);
    const cashOut = cashByManager[m.id] || 0;
    return { managerId: m.id, slot: m.slot, short: m.short, ...deriveManager(cfg, owned, cashOut) };
  });
}

/**
 * Can this manager bid on a player of the given position?
 * Needs an unfilled quota slot for the position AND an open squad slot.
 *
 * @param {LeagueConfig} cfg
 * @param {ManagerDerived} derived
 * @param {Position} position
 * @returns {boolean}
 */
export function isEligible(cfg, derived, position) {
  return derived.fills[position] < cfg.squad[position] && derived.openSlots > 0;
}

/**
 * Count unsold players grouped position x tier. Every position x configured
 * tier cell is present (zero-filled) so consumers never index-check.
 *
 * @param {LeagueConfig} cfg
 * @param {Array<{position: Position, tier: number | null}>} unsoldPlayers
 * @returns {Record<Position, Record<number, number>>}
 */
export function poolCounts(cfg, unsoldPlayers) {
  /** @type {Record<string, Record<number, number>>} */
  const pool = {};
  for (const pos of POSITIONS) {
    pool[pos] = {};
    for (const t of cfg.tiers) pool[pos][t.tier] = 0;
  }
  for (const p of unsoldPlayers) {
    if (p.tier == null || !(p.position in pool)) continue;
    if (!(p.tier in pool[p.position])) continue; // unknown tier: ignore
    pool[p.position][p.tier] += 1;
  }
  return pool;
}

const POSITION_WORDS = {
  GK: ["goalkeeper", "goalkeepers"],
  DEF: ["defender", "defenders"],
  MID: ["midfielder", "midfielders"],
  FWD: ["forward", "forwards"],
};

/**
 * Scarcity alerts: for each position x alerting tier where the remaining
 * count is at most config.scarcityThreshold and above zero, a plain sentence
 * like "Only 2 Tier-1 forwards remain". Which tiers alert comes from
 * config.scarcityTiers (a league choice, not a spec rule); the threshold
 * always comes from config too.
 *
 * @param {LeagueConfig} cfg
 * @param {Record<Position, Record<number, number>>} pool  output of poolCounts
 * @returns {string[]}
 */
export function scarcityAlerts(cfg, pool) {
  // Lenient here rather than in config-core (that file belongs to a committed
  // workstream): default to tiers 1 and 2 when the key is absent or malformed.
  const raw = /** @type {Record<string, unknown>} */ (cfg).scarcityTiers;
  const scarcityTiers = new Set(
    Array.isArray(raw) && raw.every((t) => Number.isInteger(t)) ? raw : [1, 2],
  );
  const alerts = [];
  for (const t of cfg.tiers) {
    if (!scarcityTiers.has(t.tier)) continue;
    for (const pos of POSITIONS) {
      const count = pool[pos]?.[t.tier] ?? 0;
      if (count > 0 && count <= cfg.scarcityThreshold) {
        const word = POSITION_WORDS[pos][count === 1 ? 0 : 1];
        const verb = count === 1 ? "remains" : "remain";
        alerts.push(`Only ${count} Tier-${t.tier} ${word} ${verb}`);
      }
    }
  }
  return alerts;
}

/**
 * Value-grading tertile boundaries over all current sales that have a sealed
 * valuation. The graded quantity is (value - price) / price. Returns null
 * when fewer than 3 such sales exist (not enough data to grade).
 *
 * Boundary convention (nearest-rank): sort the deltas ascending; with n
 * values, lower = sorted[ceil(n/3) - 1] and upper = sorted[ceil(2n/3) - 1].
 * A sale grades bottom tertile when delta <= lower, top when delta > upper,
 * middle otherwise.
 *
 * @param {Array<{price: number, value: number | null | undefined}>} sales
 * @returns {{lower: number, upper: number, count: number} | null}
 */
export function gradingTertiles(sales) {
  const deltas = sales
    .filter((s) => s.value != null && s.price > 0)
    .map((s) => (s.value - s.price) / s.price)
    .sort((a, b) => a - b);
  const n = deltas.length;
  if (n < 3) return null;
  return {
    lower: deltas[Math.ceil(n / 3) - 1],
    upper: deltas[Math.ceil((2 * n) / 3) - 1],
    count: n,
  };
}

/**
 * A UNIQUE on-screen name for every player in the pool (#44). Plain web_name
 * when it is the only player carrying that name; otherwise the club is
 * appended - "Wilson (WHU)" - so the room never sees the same nameplate twice
 * and cannot record a bid against the wrong player. In the rare case two
 * players share BOTH a name AND a club, a stable ordinal keeps them distinct.
 *
 * Deterministic and order-INDEPENDENT (grouping is by value, residual ties
 * break by id), so every payload that renders a name - the board, the sold
 * rail, the ledger, the squads and the console - agrees on the same label for
 * a given player as long as they are all fed the same pool.
 *
 * @param {Array<{id: number, webName: string, teamShort: string | null}>} rows
 * @returns {Map<number, string>} playerId -> display name
 */
export function displayNames(rows) {
  /** @type {Map<string, Array<{id: number, webName: string, teamShort: string | null}>>} */
  const byName = new Map();
  for (const r of rows) {
    const arr = byName.get(r.webName) || [];
    arr.push(r);
    byName.set(r.webName, arr);
  }
  /** @type {Map<number, string>} */
  const out = new Map();
  for (const [name, group] of byName) {
    if (group.length === 1) {
      out.set(group[0].id, name);
      continue;
    }
    // Shared web_name: qualify each with its club short.
    /** @type {Map<string, Array<{id: number, teamShort: string | null}>>} */
    const byTeam = new Map();
    for (const r of group) {
      const key = r.teamShort ?? "?";
      const arr = byTeam.get(key) || [];
      arr.push(r);
      byTeam.set(key, arr);
    }
    for (const teamGroup of byTeam.values()) {
      if (teamGroup.length === 1) {
        const r = teamGroup[0];
        out.set(r.id, `${name} (${r.teamShort ?? "?"})`);
      } else {
        // Same name AND club (rare): a stable ordinal by id keeps them unique.
        [...teamGroup]
          .sort((a, b) => a.id - b.id)
          .forEach((r, i) => out.set(r.id, `${name} (${r.teamShort ?? "?"} ${i + 1})`));
      }
    }
  }
  return out;
}

/**
 * v1 verdict logic for the post-sale reveal (marked per handoff):
 * delta = price - value; FAIR when |delta| <= config.valueBadgeThreshold,
 * otherwise OVERPAY when price > value, STEAL when price < value.
 * pctOver = delta / value (how far over the sealed value the hammer landed;
 * negative = under). Null when the value is 0 or missing.
 *
 * @param {LeagueConfig} cfg
 * @param {number} price
 * @param {number | null | undefined} value
 * @returns {{delta: number | null, pctOver: number | null, verdict: "OVERPAY" | "FAIR" | "STEAL" | null}}
 */
export function saleVerdict(cfg, price, value) {
  if (value == null) return { delta: null, pctOver: null, verdict: null };
  const delta = price - value;
  const verdict =
    Math.abs(delta) <= cfg.valueBadgeThreshold
      ? "FAIR"
      : price > value
        ? "OVERPAY"
        : "STEAL";
  const pctOver = value !== 0 ? delta / value : null;
  return { delta, pctOver, verdict };
}
