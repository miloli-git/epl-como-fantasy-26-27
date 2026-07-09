// Assembles the GET /api/player/[id] payload: the single-player read-only
// spotlight behind a ledger click (#51). It is the board's "on the block"
// player card MINUS all live bidding data - no opening bid, no max-bids, no
// manager strip, no pool/scarcity, no reveal. Plain JS with the postgres.js
// client + config INJECTED, so the integration test
// (scripts/test-player-detail.mjs) drives the exact same assembly the route
// serves, without a build step. lib/player-detail.ts wraps this with the app's
// shared pool + config; app/api/player/[id]/route.ts is a thin wrapper.
//
// SEALING IS STRUCTURAL HERE, exactly as in lib/state-core.mjs: the valuations
// table is joined in EXACTLY ONE query - saleRowsQuery - which starts FROM
// sales, so a valuation can only ever ride on a player that is currently sold.
// The base player query (playerRowsQuery) never mentions valuations at all, so
// an UNSOLD player cannot carry a value: not by a filter, by the shape of the
// query. The route/page then attach `value` only to the `sale` object, which is
// null unless the player is sold. If you add a second valuations join, or move
// `value` onto the base `player` object, you have broken the seal.

import { displayNames, saleVerdict } from "./derive-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */

/** numeric columns come back from postgres.js as strings */
function num(v) {
  return v == null ? null : Number(v);
}

/**
 * Build the /api/player/[id] payload for a single player.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client
 * @param {LeagueConfig} cfg
 * @param {number} playerId
 * @returns {Promise<object | null>} the payload, or null if the player is unknown
 */
export async function buildPlayerDetailPayload(sql, cfg, playerId) {
  const [appStateRows, playerRows, saleRows, moveRows, managerRows, nameRows] =
    await Promise.all([
      sql`select version from app_state where id = 1`,
      // Base player + morning brief. NO valuations join here - structurally
      // sealed, mirroring state-core's current-lot query.
      sql`
        select p.*, b.bullets
        from players p
        left join briefs b on b.player_id = p.id
        where p.id = ${playerId}
      `,
      // The ONLY query that touches valuations: rooted in sales, so a value can
      // only appear for a player that is currently sold. Returns zero rows for
      // an unsold player (sales.player_id is unique, so at most one row).
      sql`
        select s.player_id, s.manager_id, s.price, s.lot_no, s.phase, v.value
        from sales s
        left join valuations v on v.player_id = s.player_id
        where s.player_id = ${playerId}
      `,
      // Non-voided trade movements for THIS player, oldest-first (trade id as
      // the seq): the last leg's destination is the current owner. No
      // valuations here.
      sql`
        select tp.to_manager, t.id as seq
        from trade_players tp
        join trades t on t.id = tp.trade_id
        where t.voided = false and tp.player_id = ${playerId}
        order by t.id
      `,
      sql`select id, slot, short from managers order by slot`,
      // Whole-pool name universe (#44): id/web_name/team_short of every player,
      // so a shared surname is disambiguated the same way here as on the board
      // and ledger. Names only - no valuations, no sealing concern.
      sql`select id, web_name, team_short from players`,
    ]);

  const p = playerRows[0];
  if (!p) return null; // unknown player id -> route returns 404

  const version = appStateRows[0] ? Number(appStateRows[0].version) : 0;

  // Disambiguated on-screen name (#44), computed over the whole pool.
  const displayNameById = displayNames(
    nameRows.map((r) => ({ id: r.id, webName: r.web_name, teamShort: r.team_short })),
  );

  // --- the read-only spotlight (NO bidding data, NO value) ------------
  const player = {
    id: p.id,
    code: p.code,
    name: p.web_name,
    displayName: displayNameById.get(p.id) ?? p.web_name,
    firstName: p.first_name,
    secondName: p.second_name,
    teamId: p.team_id,
    teamShort: p.team_short,
    teamCode: p.team_code,
    position: p.position,
    fplPrice: num(p.fpl_price),
    tier: p.tier,
    stats: {
      pts: p.pts,
      goals: p.goals,
      assists: p.assists,
      bonus: p.bonus,
      starts: p.starts,
      minutes: p.minutes,
      cleanSheets: p.clean_sheets,
      saves: p.saves,
      pensMissed: p.pens_missed,
      yellows: p.yellows,
      reds: p.reds,
      selectedBy: num(p.selected_by),
    },
    overallRank: p.overall_rank,
    positionRank: p.position_rank,
    age: p.age,
    nationality: p.nationality,
    heightCm: p.height_cm,
    prevComoOwner: p.prev_como_owner,
    prevComoPrice: p.prev_como_price,
    brief: p.bullets ?? null,
  };

  // --- sale result (#51: full spotlight + sale result for a SOLD player) --
  // Value is read ONLY from the sales-rooted saleRows; it is attached ONLY to
  // this `sale` object, which stays null unless the player has a sale row. The
  // owner is resolved THROUGH trades (salary travels with the player), matching
  // the ledger the click came from.
  let sale = null;
  const s = saleRows[0];
  if (s) {
    const shortById = new Map(managerRows.map((m) => [m.id, m.short]));
    const slotById = new Map(managerRows.map((m) => [m.id, m.slot]));
    // Current owner: the destination of the last non-voided trade leg, else the
    // manager who bought the player at auction.
    const lastMove = moveRows.length > 0 ? moveRows[moveRows.length - 1] : null;
    const ownerId = lastMove ? lastMove.to_manager : s.manager_id;
    const v = saleVerdict(cfg, s.price, num(s.value));
    sale = {
      ownerSlot: slotById.get(ownerId) ?? null,
      ownerShort: shortById.get(ownerId) ?? null,
      price: s.price,
      lotNo: s.lot_no != null ? Number(s.lot_no) : null,
      // Unsealed at the hammer: legitimate for a sold player.
      value: num(s.value),
      delta: v.delta,
      verdict: v.verdict,
    };
  }

  return {
    version,
    player,
    sale,
    generatedAt: new Date().toISOString(),
  };
}
