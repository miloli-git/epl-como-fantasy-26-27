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
  tradeCashByManager,
} from "./derive-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */

const RECENT_SALES = 4;
const RECENT_TRADES = 4;
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
  const [appStateRows, managerRows, soldRows, moveRows, tradeRows] = await Promise.all([
    sql`select * from app_state where id = 1`,
    sql`select id, slot, short from managers order by slot`,
    // The ONLY query that touches valuations: rooted in sales, so values can
    // only appear for players that are currently sold.
    sql`
      select s.id as sale_id, s.player_id, s.manager_id, s.price, s.lot_no,
             s.phase, s.created_at,
             p.web_name, p.code, p.position, p.tier,
             v.value
      from sales s
      join players p on p.id = s.player_id
      left join valuations v on v.player_id = s.player_id
      order by s.created_at desc, s.id desc
    `,
    // Trades (#18): non-voided player movements (oldest-first via trade id as
    // the seq) and non-voided trade cash. Folded into ownership + spend below
    // so every board number is post-trade correct. No valuations here.
    sql`
      select tp.player_id, tp.from_manager, tp.to_manager, t.id as seq
      from trade_players tp
      join trades t on t.id = tp.trade_id
      where t.voided = false
      order by t.id
    `,
    sql`
      select t.id, t.manager_a, t.manager_b, t.cash_a_to_b, t.cash_b_to_a,
             t.created_at
      from trades t
      where t.voided = false
      order by t.created_at desc, t.id desc
    `,
  ]);

  const appState = appStateRows[0] ?? null;
  const currentPlayerId = appState?.current_player_id ?? null;
  const soldIds = new Set(soldRows.map((r) => r.player_id));

  const [currentLotRows, unsoldRows] = await Promise.all([
    currentPlayerId != null
      ? // NO valuations join here - structurally sealed.
        sql`
          select p.*, b.bullets,
                 (select max(e.lot_no) from lot_events e where e.player_id = p.id) as lot_no
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

  // --- managers (ownership + cash resolved THROUGH trades, #18) --------
  const movements = moveRows.map((r) => ({
    playerId: r.player_id,
    fromManager: r.from_manager,
    toManager: r.to_manager,
    seq: Number(r.seq),
  }));
  const ownership = resolveOwnership(
    soldRows.map((r) => ({
      playerId: r.player_id,
      managerId: r.manager_id,
      price: r.price,
      position: r.position,
    })),
    movements,
  );
  const cashByManager = tradeCashByManager(
    tradeRows.map((t) => ({
      managerA: t.manager_a,
      managerB: t.manager_b,
      cashAToB: t.cash_a_to_b,
      cashBToA: t.cash_b_to_a,
    })),
  );
  const derived = deriveManagers(cfg, managerRows, ownership, cashByManager);
  const managerShortById = new Map(managerRows.map((m) => [m.id, m.short]));
  // Player display details keyed by player id (name / position / tier and the
  // salary that travels with the player). Ownership above decides WHO holds
  // each player now; this map only supplies how to draw them.
  const soldByPlayer = new Map(
    soldRows.map((r) => [
      r.player_id,
      { name: r.web_name, position: r.position, tier: r.tier },
    ]),
  );
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
    // Current squad = players this manager owns NOW (post-trade), each still
    // carrying its original sale salary. Oldest-first (ownership preserves the
    // newest-first soldRows order, so reverse).
    squad: ownership
      .filter((o) => o.managerId === m.managerId)
      .map((o) => {
        const d = soldByPlayer.get(o.playerId);
        return {
          playerId: o.playerId,
          name: d?.name ?? null,
          position: o.position,
          tier: d?.tier ?? null,
          price: o.price,
        };
      })
      .reverse(),
  }));

  // --- recent trades (public: the board announces recorded trades) ----
  // Grouped by trade id (moveRows selected the trade id as `seq`). Player
  // names come from soldByPlayer - a traded player is by definition sold, so
  // it is always present there.
  const movesByTrade = new Map();
  for (const mv of moveRows) {
    const arr = movesByTrade.get(mv.seq) || [];
    arr.push(mv);
    movesByTrade.set(mv.seq, arr);
  }
  const recentTrades = tradeRows.slice(0, RECENT_TRADES).map((t) => ({
    tradeId: t.id,
    managerAShort: managerShortById.get(t.manager_a) ?? null,
    managerBShort: managerShortById.get(t.manager_b) ?? null,
    cashAToB: t.cash_a_to_b,
    cashBToA: t.cash_b_to_a,
    players: (movesByTrade.get(t.id) || []).map((mv) => ({
      playerId: mv.player_id,
      name: soldByPlayer.get(mv.player_id)?.name ?? null,
      fromShort: managerShortById.get(mv.from_manager) ?? null,
      toShort: managerShortById.get(mv.to_manager) ?? null,
    })),
    createdAt: new Date(t.created_at).toISOString(),
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
      lotNo: lot.lot_no != null ? Number(lot.lot_no) : null,
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
      code: r.code,
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
    recentTrades,
    managers,
    pool,
    scarcity,
    grading,
    reveal,
    squad: cfg.squad,
    pollMs: cfg.pollMs,
    revealMs: cfg.revealMs,
    generatedAt: new Date().toISOString(),
  };
}
