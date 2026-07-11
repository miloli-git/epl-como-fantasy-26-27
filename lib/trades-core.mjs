// Assembles the GET /api/trades payload: a read-only log of every recorded
// trade (issue #58). Companion read to lib/trade-core.mjs (the WRITE side,
// which owns recordTrade and all the guardrails); this file never mutates
// anything and never enforces a rule - it only reads back what recordTrade
// already validated and wrote.
//
// SEALING: a trade carries player identity and cash, never a player's sealed
// value. This core does not touch the valuations table at all, so it cannot
// widen the seal.
//
// Plain JS with the postgres.js client + config INJECTED, so the integration
// test (scripts/test-trades.mjs) drives the exact same assembly the route
// serves.

import { displayNames } from "./derive-core.mjs";

/** numeric columns come back from postgres.js as strings */
function num(v) {
  return v == null ? null : Number(v);
}

/**
 * Build the whole /api/trades payload: every non-voided trade, newest first.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client
 * @param {import("./config-core.mjs").LeagueConfig} cfg
 */
export async function buildTradesPayload(sql, cfg) {
  const season = cfg.season ?? "current";

  const tradeRows = await sql`
    select t.id, t.created_at, t.stage,
           t.manager_a, t.manager_b, t.cash_a_to_b, t.cash_b_to_a,
           ma.slot as a_slot, ma.short as a_short,
           mb.slot as b_slot, mb.short as b_short
    from trades t
    join managers ma on ma.id = t.manager_a
    join managers mb on mb.id = t.manager_b
    where t.voided = false
    order by t.id desc
  `;

  const tradeIds = tradeRows.map((t) => t.id);
  const legRows =
    tradeIds.length === 0
      ? []
      : await sql`
          select tp.trade_id, tp.player_id, tp.from_manager, tp.to_manager,
                 p.web_name, p.team_short, p.position
          from trade_players tp
          join players p on p.id = tp.player_id
          where tp.trade_id in ${sql(tradeIds)}
          order by tp.player_id
        `;

  // Disambiguated on-screen labels (#44) computed over the WHOLE pool, not just
  // the players that happen to have moved - so a shared surname is qualified
  // identically here and on the ledger/board even when only one twin ever
  // traded (matching lib/players-core.mjs). Skipped entirely when there are no
  // trades to label.
  const names =
    tradeIds.length === 0
      ? new Map()
      : displayNames(
          (await sql`select id, web_name, team_short from players`).map((r) => ({
            id: r.id,
            webName: r.web_name,
            teamShort: r.team_short,
          })),
        );

  const legsByTrade = new Map();
  for (const r of legRows) {
    const arr = legsByTrade.get(r.trade_id) || [];
    arr.push(r);
    legsByTrade.set(r.trade_id, arr);
  }

  /** shape one trade_players row into a payload player entry */
  const toMovePlayer = (r) => ({
    id: r.player_id,
    name: names.get(r.player_id) ?? r.web_name,
    webName: r.web_name,
    teamShort: r.team_short,
    position: r.position,
  });

  const trades = tradeRows.map((t) => {
    const legs = legsByTrade.get(t.id) || [];
    const playersAToB = legs.filter((r) => r.from_manager === t.manager_a).map(toMovePlayer);
    const playersBToA = legs.filter((r) => r.from_manager !== t.manager_a).map(toMovePlayer);
    return {
      id: t.id,
      createdAt: new Date(t.created_at).toISOString(),
      stage: t.stage,
      managerA: { slot: t.a_slot, short: t.a_short },
      managerB: { slot: t.b_slot, short: t.b_short },
      cashAToB: num(t.cash_a_to_b) ?? 0,
      cashBToA: num(t.cash_b_to_a) ?? 0,
      playersAToB,
      playersBToA,
    };
  });

  return {
    season,
    count: trades.length,
    trades,
    generatedAt: new Date().toISOString(),
  };
}
