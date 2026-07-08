// Shared ownership/cash loader (issues #15, #18, trades feature). Plain JS so
// scripts and the typed wrappers use the exact same queries without a build
// step. No config, no derivation here - just the raw rows that derive-core's
// resolveOwnership + tradeCashByManager turn into current ownership and spend.
//
// EVERY per-manager derived number in the app (board budgets/max-bids, squad
// completeness for the phase-2 rotation, sale legality, correction re-checks)
// must resolve through trades, or a player traded between managers would be
// counted for the wrong one. This loader is the single seam that makes that
// consistent: sale price is the salary and it TRAVELS with the player; trade
// cash settles separately.

/**
 * @typedef {Object} OwnershipContext
 * @property {Array<{saleId: number, playerId: number, managerId: number, price: number, position: string}>} sales
 * @property {import("./derive-core.mjs").TradeMovement[]} movements   non-voided, seq = trade id
 * @property {Array<{tradeId: number, managerA: number, managerB: number, cashAToB: number, cashBToA: number}>} trades  non-voided
 */

/**
 * Load every sale (with its player's position), every non-voided trade
 * movement (ordered oldest-first via the trade id as the seq), and every
 * non-voided trade's cash. Works with either a pool client or a transaction
 * client - pass whichever the caller already holds (mutations pass their
 * locked tx so the read is consistent with the write).
 *
 * @param {import("postgres").Sql | import("postgres").TransactionSql} db
 * @returns {Promise<OwnershipContext>}
 */
export async function loadOwnershipContext(db) {
  const [saleRows, moveRows, tradeRows] = await Promise.all([
    db`
      select s.id, s.player_id, s.manager_id, s.price, p.position
      from sales s
      join players p on p.id = s.player_id
    `,
    db`
      select tp.player_id, tp.from_manager, tp.to_manager, t.id as seq
      from trade_players tp
      join trades t on t.id = tp.trade_id
      where t.voided = false
      order by t.id
    `,
    db`
      select id, manager_a, manager_b, cash_a_to_b, cash_b_to_a
      from trades
      where voided = false
    `,
  ]);

  return {
    sales: saleRows.map((r) => ({
      saleId: r.id,
      playerId: r.player_id,
      managerId: r.manager_id,
      price: r.price,
      position: r.position,
    })),
    movements: moveRows.map((r) => ({
      playerId: r.player_id,
      fromManager: r.from_manager,
      toManager: r.to_manager,
      seq: Number(r.seq),
    })),
    trades: tradeRows.map((r) => ({
      tradeId: r.id,
      managerA: r.manager_a,
      managerB: r.manager_b,
      cashAToB: r.cash_a_to_b,
      cashBToA: r.cash_b_to_a,
    })),
  };
}
