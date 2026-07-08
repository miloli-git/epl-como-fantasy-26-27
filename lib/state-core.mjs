// Assembles the GET /api/state payload: queries + derivation. Plain JS with
// the postgres.js client and the league config INJECTED, so the integration
// test (scripts/test-state.mjs) can drive the exact same assembly the route
// serves, without a build step. lib/state.ts wraps this with the app's shared
// pool and config; app/api/state/route.ts is a thin wrapper over that.
//
// SEALING IS STRUCTURAL HERE: the valuations table is joined in exactly one
// query - soldRowsQuery - which starts FROM sales, so a valuation can only
// ever ride on a player with a current sales row. The current-lot, up-next
// and pool queries never mention valuations at all.

import { openBidFor } from "./config-core.mjs";
import {
  deriveManagers,
  gradingTertiles,
  poolCounts,
  resolveOwnership,
  saleVerdict,
  scarcityAlerts,
} from "./derive-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */

const RECENT_SALES = 4;
const UP_NEXT = 5;

/** numeric columns come back from postgres.js as strings */
function num(v) {
  return v == null ? null : Number(v);
}

/**
 * Build the whole /api/state payload.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client
 * @param {LeagueConfig} cfg
 */
export async function buildStatePayload(sql, cfg) {
  const [appStateRows, managerRows, soldRows, tradeCountRows] = await Promise.all([
    sql`select * from app_state where id = 1`,
    sql`select id, slot, short from managers order by slot`,
    // The ONLY query that touches valuations: rooted in sales, so values can
    // only appear for players that are currently sold.
    sql`
      select s.id as sale_id, s.player_id, s.manager_id, s.price, s.lot_no,
             s.phase, s.created_at,
             p.web_name, p.position, p.tier,
             v.value
      from sales s
      join players p on p.id = s.player_id
      left join valuations v on v.player_id = s.player_id
      order by s.created_at desc, s.id desc
    `,
    // S3 seam guard: assembly does not fold trades in yet, so any trade row
    // means every derived number below would be wrong.
    sql`select count(*)::int as n from trade_players`,
  ]);

  if ((tradeCountRows[0]?.n ?? 0) > 0) {
    throw new Error(
      "Trades exist but state assembly does not fold in trade movements yet (S3). Refusing to serve wrong numbers.",
    );
  }

  const appState = appStateRows[0] ?? null;
  const currentPlayerId = appState?.current_player_id ?? null;
  const soldIds = new Set(soldRows.map((r) => r.player_id));

  const [currentLotRows, unsoldRows] = await Promise.all([
    currentPlayerId != null
      ? // NO valuations join here - structurally sealed.
        sql`
          select p.*, b.bullets
          from players p
          left join briefs b on b.player_id = p.id
          where p.id = ${currentPlayerId}
        `
      : Promise.resolve([]),
    // Unsold pool - again no valuations join.
    sql`
      select p.position, p.tier
      from players p
      left join sales s on s.player_id = p.id
      where s.player_id is null
    `,
  ]);

  // --- managers -------------------------------------------------------
  const ownership = resolveOwnership(
    soldRows.map((r) => ({
      playerId: r.player_id,
      managerId: r.manager_id,
      price: r.price,
      position: r.position,
    })),
    // Trades tables are empty until S3; movements fold in here then.
  );
  const derived = deriveManagers(cfg, managerRows, ownership);
  const managerShortById = new Map(managerRows.map((m) => [m.id, m.short]));
  const managers = derived.map((m) => ({
    id: m.managerId,
    slot: m.slot,
    short: m.short,
    spent: m.spent,
    remaining: m.remaining,
    fills: m.fills,
    openSlots: m.openSlots,
    maxBid: m.maxBid,
    squadComplete: m.squadComplete,
    squad: soldRows
      .filter((r) => r.manager_id === m.managerId)
      .map((r) => ({
        playerId: r.player_id,
        name: r.web_name,
        position: r.position,
        tier: r.tier,
        price: r.price,
      }))
      .reverse(), // soldRows is newest-first; squads read oldest-first
  }));

  // --- current lot ----------------------------------------------------
  let currentLot = null;
  const lot = currentLotRows[0];
  if (lot) {
    currentLot = {
      id: lot.id,
      code: lot.code,
      name: lot.web_name,
      firstName: lot.first_name,
      secondName: lot.second_name,
      teamId: lot.team_id,
      teamShort: lot.team_short,
      teamCode: lot.team_code,
      position: lot.position,
      fplPrice: num(lot.fpl_price),
      tier: lot.tier,
      openBid: lot.tier != null ? openBidFor(cfg, lot.tier) : null,
      stats: {
        pts: lot.pts,
        goals: lot.goals,
        assists: lot.assists,
        bonus: lot.bonus,
        starts: lot.starts,
        minutes: lot.minutes,
        cleanSheets: lot.clean_sheets,
        saves: lot.saves,
        pensMissed: lot.pens_missed,
        yellows: lot.yellows,
        reds: lot.reds,
        selectedBy: num(lot.selected_by),
      },
      overallRank: lot.overall_rank,
      positionRank: lot.position_rank,
      age: lot.age,
      nationality: lot.nationality,
      heightCm: lot.height_cm,
      prevComoOwner: lot.prev_como_owner,
      prevComoPrice: lot.prev_como_price,
      brief: lot.bullets ?? null,
    };
  }

  // --- up next --------------------------------------------------------
  // The next few queue entries after the current lot. Public by design: the
  // war-room model has no private data; the console consumes this.
  let upNext = [];
  const queue = Array.isArray(appState?.lot_queue) ? appState.lot_queue : [];
  // No lot on the block = no up-next (phase-1 queue exhausted, or phase 2
  // between nominations): listing dead no-bid players there would mislead the
  // auctioneer at the exact moment they decide whether to end phase one.
  if (currentPlayerId != null && queue.length > 0) {
    const idx = queue.indexOf(currentPlayerId);
    const upcomingIds = queue
      .slice(idx + 1)
      .filter((id) => !soldIds.has(id) && id !== currentPlayerId)
      .slice(0, UP_NEXT);
    if (upcomingIds.length > 0) {
      // NO valuations join here either.
      const rows = await sql`
        select id, web_name, tier from players where id in ${sql(upcomingIds)}
      `;
      const byId = new Map(rows.map((r) => [r.id, r]));
      upNext = upcomingIds
        .filter((id) => byId.has(id))
        .map((id) => {
          const r = byId.get(id);
          return { id: r.id, name: r.web_name, tier: r.tier };
        });
    }
  }

  // --- recent sales + reveal ------------------------------------------
  // Only sold players reach this block, so carrying the valuation is allowed.
  const recentSales = soldRows.slice(0, RECENT_SALES).map((r) => {
    const v = saleVerdict(cfg, r.price, r.value);
    return {
      saleId: r.sale_id,
      playerId: r.player_id,
      playerName: r.web_name,
      position: r.position,
      tier: r.tier,
      managerShort: managerShortById.get(r.manager_id) ?? null,
      price: r.price,
      lotNo: r.lot_no,
      value: r.value,
      delta: v.delta,
      verdict: v.verdict,
      createdAt: r.created_at,
    };
  });

  let reveal = null;
  const last = soldRows[0];
  if (last) {
    const v = saleVerdict(cfg, last.price, last.value);
    reveal = {
      saleId: last.sale_id,
      playerId: last.player_id,
      playerName: last.web_name,
      managerShort: managerShortById.get(last.manager_id) ?? null,
      price: last.price,
      value: last.value,
      delta: v.delta,
      pctOver: v.pctOver,
      verdict: v.verdict,
      createdAt: last.created_at,
    };
  }

  // --- pool, scarcity, grading ----------------------------------------
  const pool = poolCounts(cfg, unsoldRows);
  const scarcity = scarcityAlerts(cfg, pool);
  const grading = gradingTertiles(soldRows);

  // Reveal auto-expiry is computed at read time from the stored instant:
  // recordSale sets tv_view='reveal' with reveal_until = created_at +
  // revealMs; reads write nothing. A stored 'reveal' is REPORTED as 'block'
  // (the TV's default) iff reveal_until is set and has passed. A NULL
  // reveal_until means "persist until changed" - that is what the future
  // console set_tv override will write.
  let tvView = appState?.tv_view ?? "block";
  if (tvView === "reveal" && appState?.reveal_until != null) {
    if (new Date(appState.reveal_until).getTime() < Date.now()) tvView = "block";
  }

  return {
    version: appState ? Number(appState.version) : 0,
    phase: appState?.phase ?? 1,
    paused: appState?.paused ?? false,
    tvView,
    currentLot,
    upNext,
    nominationTurn: appState?.nomination_turn ?? null,
    recentSales,
    managers,
    pool,
    scarcity,
    grading,
    reveal,
    pollMs: cfg.pollMs,
    revealMs: cfg.revealMs,
    generatedAt: new Date().toISOString(),
  };
}
