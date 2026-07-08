// In-auction trades (PRD "In-auction trades (v1 must-have)"): a two-sided
// move of players and/or cash between two managers, entered by the
// auctioneer. Plain JS (with JSDoc types) so scripts/test-trade.mjs drives the
// exact same transaction the POST /api/trade route serves, without a build
// step. lib/trade.ts wraps this with the app's pool + config.
//
// MONEY/OWNERSHIP CRITICAL. Runs inside withAuctionLock (lib/draft-core.mjs):
// the FOR UPDATE on the app_state singleton serialises a trade against every
// sale, correction and lot action, so a trade can never interleave with a sale
// for the same player - whichever grabs the lock first commits, the second
// re-reads the committed world and re-validates. Salaries TRAVEL with players
// (handled by resolveOwnership); cash settles the difference (tradeCashByManager).
//
// GUARDRAILS are checked by SIMULATING the post-trade world with the exact
// same derivation the board uses (resolveOwnership + tradeCashByManager +
// deriveManager), so what we enforce can never drift from what the room sees:
// neither manager may end with a negative budget, a position quota over its
// config cap, or more than a full squad.
//
// v1 scope note: there is no trade-void endpoint. A mistaken trade is undone by
// entering the reverse trade (the derivation always honours the latest
// non-voided movement). The trades.voided column is respected by every reader
// for a future void feature.

import { squadSize } from "./config-core.mjs";
import { withAuctionLock } from "./draft-core.mjs";
import { deriveManager, resolveOwnership, tradeCashByManager } from "./derive-core.mjs";
import { loadOwnershipContext } from "./ownership-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */

/**
 * @typedef {Object} TradeRejection
 * @property {false} ok
 * @property {string} code    machine-readable rule name
 * @property {string} message plain-English rule, console-displayable
 */

/** @param {string} code @param {string} message @returns {TradeRejection} */
function reject(code, message) {
  return { ok: false, code, message };
}

/** Integer >= 0. */
function isNonNegInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** An array of distinct positive integers (player ids). */
function asIdList(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : null; // null signals "not an array"
}

/**
 * Record a two-sided trade. Validates ownership + guardrails inside the
 * serialising transaction, writes the trade + its player legs + an audit row,
 * bumps the version. Returns a structured result; never throws for a rule
 * violation (only for infrastructure failures).
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {LeagueConfig} cfg
 * @param {{
 *   managerA: number, managerB: number,
 *   playersAToB?: number[], playersBToA?: number[],
 *   cashAToB?: number, cashBToA?: number,
 *   reason?: string, actor: string
 * }} args
 * @returns {Promise<{ok: true, tradeId: number, createdAt: string,
 *   managerA: {id: number, remaining: number, fills: Record<string, number>, openSlots: number},
 *   managerB: {id: number, remaining: number, fills: Record<string, number>, openSlots: number}
 * } | TradeRejection>}
 */
export async function recordTrade(sql, cfg, args) {
  const {
    managerA,
    managerB,
    cashAToB = 0,
    cashBToA = 0,
    reason,
    actor,
  } = args;

  // --- shape checks (no DB needed; do them before taking the lock) -----
  if (!Number.isInteger(managerA) || !Number.isInteger(managerB)) {
    return reject("bad_manager", "managerA and managerB must be whole-number manager ids.");
  }
  if (managerA === managerB) {
    return reject("same_manager", "A trade needs two different managers.");
  }
  if (!isNonNegInt(cashAToB) || !isNonNegInt(cashBToA)) {
    return reject(
      "bad_cash",
      "Cash amounts must be whole numbers of dollars of zero or more.",
    );
  }
  const playersAToB = asIdList(args.playersAToB);
  const playersBToA = asIdList(args.playersBToA);
  if (playersAToB === null || playersBToA === null) {
    return reject("bad_players", "playersAToB and playersBToA must be arrays of player ids.");
  }
  for (const id of [...playersAToB, ...playersBToA]) {
    if (!Number.isInteger(id)) {
      return reject("bad_players", `player ids must be whole numbers (got ${JSON.stringify(id)}).`);
    }
  }
  const allMoved = [...playersAToB, ...playersBToA];
  if (new Set(allMoved).size !== allMoved.length) {
    return reject(
      "player_overlap",
      "A player cannot appear twice in one trade (check both directions for duplicates).",
    );
  }
  if (allMoved.length === 0 && cashAToB === 0 && cashBToA === 0) {
    return reject("empty_trade", "A trade must move at least one player or some cash.");
  }

  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) {
      return reject(
        "no_state",
        "The draft has not been initialised (app_state is empty). Run the seed first.",
      );
    }

    // Both managers must exist.
    const mgrRows = await tx`
      select id, short from managers where id in ${tx([managerA, managerB])}
    `;
    const shortById = new Map(mgrRows.map((m) => [m.id, m.short]));
    if (!shortById.has(managerA)) return reject("unknown_manager", `No manager with id ${managerA} exists.`);
    if (!shortById.has(managerB)) return reject("unknown_manager", `No manager with id ${managerB} exists.`);

    // Current world (post-lock), resolved through existing non-voided trades.
    const ctx = await loadOwnershipContext(tx);
    const ownershipBefore = resolveOwnership(ctx.sales, ctx.movements);
    const ownerByPlayer = new Map(ownershipBefore.map((o) => [o.playerId, o.managerId]));

    // Every moved player must currently be owned by the manager giving it away.
    for (const id of playersAToB) {
      const owner = ownerByPlayer.get(id);
      if (owner !== managerA) {
        return reject(
          "not_owned",
          owner == null
            ? `Player ${id} is not owned by anyone, so ${shortById.get(managerA)} cannot trade it away.`
            : `Player ${id} is owned by ${shortById.get(owner) ?? `manager ${owner}`}, not ${shortById.get(managerA)}.`,
        );
      }
    }
    for (const id of playersBToA) {
      const owner = ownerByPlayer.get(id);
      if (owner !== managerB) {
        return reject(
          "not_owned",
          owner == null
            ? `Player ${id} is not owned by anyone, so ${shortById.get(managerB)} cannot trade it away.`
            : `Player ${id} is owned by ${shortById.get(owner) ?? `manager ${owner}`}, not ${shortById.get(managerB)}.`,
        );
      }
    }

    // Simulate the post-trade world with the SAME derivation the board uses:
    // append this trade's movements (newest seq) and its cash, then derive both
    // managers. What we enforce is exactly what the room will see.
    const maxSeq = ctx.movements.reduce((m, mv) => Math.max(m, mv.seq), 0);
    const newMovements = [
      ...ctx.movements,
      ...playersAToB.map((id, i) => ({ playerId: id, fromManager: managerA, toManager: managerB, seq: maxSeq + 1 + i })),
      ...playersBToA.map((id, i) => ({
        playerId: id,
        fromManager: managerB,
        toManager: managerA,
        seq: maxSeq + 1 + playersAToB.length + i,
      })),
    ];
    const newTrades = [
      ...ctx.trades,
      { managerA, managerB, cashAToB, cashBToA },
    ];
    const ownershipAfter = resolveOwnership(ctx.sales, newMovements);
    const cashAfter = tradeCashByManager(newTrades);

    const size = squadSize(cfg);
    /** Derive one side and run the guardrails; returns a rejection or null. */
    const checkSide = (mid) => {
      const owned = ownershipAfter.filter((o) => o.managerId === mid);
      const d = deriveManager(cfg, owned, cashAfter[mid] || 0);
      const short = shortById.get(mid);
      if (d.remaining < 0) {
        return reject(
          "negative_budget",
          `${short} would be $${-d.remaining} over budget after this trade (remaining $${d.remaining}). Rejected.`,
        );
      }
      if (owned.length > size) {
        return reject(
          "squad_overfull",
          `${short} would hold ${owned.length} players after this trade (max ${size}). Rejected.`,
        );
      }
      for (const pos of ["GK", "DEF", "MID", "FWD"]) {
        if (d.fills[pos] > cfg.squad[pos]) {
          return reject(
            "quota_exceeded",
            `${short} would have ${d.fills[pos]} ${pos} after this trade (max ${cfg.squad[pos]}). Rejected.`,
          );
        }
      }
      return { d };
    };

    const a = checkSide(managerA);
    if (a.ok === false) return a;
    const b = checkSide(managerB);
    if (b.ok === false) return b;

    // --- all guardrails pass: write the trade -------------------------
    const [trade] = await tx`
      insert into trades (manager_a, manager_b, cash_a_to_b, cash_b_to_a)
      values (${managerA}, ${managerB}, ${cashAToB}, ${cashBToA})
      returning id, created_at
    `;
    for (const id of playersAToB) {
      await tx`
        insert into trade_players (trade_id, player_id, from_manager, to_manager)
        values (${trade.id}, ${id}, ${managerA}, ${managerB})
      `;
    }
    for (const id of playersBToA) {
      await tx`
        insert into trade_players (trade_id, player_id, from_manager, to_manager)
        values (${trade.id}, ${id}, ${managerB}, ${managerA})
      `;
    }

    await tx`
      insert into audit_log (actor, action, entity, entity_id, before, after, reason)
      values (
        ${actor}, 'trade.create', 'trade', ${trade.id}, ${null},
        ${tx.json({
          managerA,
          managerAShort: shortById.get(managerA),
          managerB,
          managerBShort: shortById.get(managerB),
          playersAToB,
          playersBToA,
          cashAToB,
          cashBToA,
        })},
        ${reason && String(reason).trim() !== "" ? String(reason).trim() : null}
      )
    `;

    await tx`update app_state set version = version + 1 where id = 1`;

    return {
      ok: true,
      tradeId: trade.id,
      createdAt: new Date(trade.created_at).toISOString(),
      managerA: { id: managerA, remaining: a.d.remaining, fills: a.d.fills, openSlots: a.d.openSlots },
      managerB: { id: managerB, remaining: b.d.remaining, fills: b.d.fills, openSlots: b.d.openSlots },
    };
  });
}
