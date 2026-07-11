// Assembles the GET /api/recap payload: the post-auction recap + awards.
//
// TWO things the recap shows:
//   1. Leftover money (Y1) per manager - the "war chest" that carries into
//      February under the season-economy model (#28/#32). Shown from the
//      durable season_recap snapshot when one exists for this season (a NUMBER
//      OF RECORD); otherwise derived live so the page works before archiving.
//   2. Awards derived from the ledger: biggest overpay and steal of the night
//      (price vs the sealed value) and the fastest hammer (shortest time a lot
//      spent on the block before it sold).
//
// SEALING: this core does NOT touch the valuations table itself. It reuses
// buildPlayersPayload (lib/players-core.mjs), where the valuations join is
// structurally rooted in sales - so a value can only ever ride on a SOLD
// player. The awards below read `value` only from already-sold rows. No new
// valuations query is introduced here, so the seal is not widened.
//
// Plain JS with the postgres.js client + config INJECTED, so the integration
// test (scripts/test-recap.mjs) drives the exact same assembly the route serves.

import { buildPlayersPayload } from "./players-core.mjs";

/** numeric columns come back from postgres.js as strings */
function num(v) {
  return v == null ? null : Number(v);
}

/**
 * Build the whole /api/recap payload.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client
 * @param {import("./config-core.mjs").LeagueConfig} cfg
 */
export async function buildRecapPayload(sql, cfg) {
  const season = cfg.season ?? "current";

  // Reuse the players assembly (sealing lives there). Gives us per-player
  // sold/price/value/delta/owner and per-manager spent/remaining/squad size.
  const players = await buildPlayersPayload(sql, cfg);

  const [archiveRows, hammerRows, buyerRows] = await Promise.all([
    // Durable leftover snapshot for THIS season, if the archive step has run.
    sql`
      select manager_slot, manager_short, spent, leftover, squad_count, created_at
      from season_recap
      where season = ${season}
      order by manager_slot
    `,
    // Fastest hammer: for each sale, how long the lot sat on the block before it
    // sold = sale time minus the most recent offer/nomination of that player at
    // or before the sale. Degrades to empty if there is no offer history.
    sql`
      select s.player_id,
             extract(epoch from (s.created_at - lo.offered_at)) as seconds
      from sales s
      join lateral (
        select max(le.created_at) as offered_at
        from lot_events le
        where le.player_id = s.player_id
          and le.event in ('offered', 'nominated')
          and le.created_at <= s.created_at
      ) lo on true
      where lo.offered_at is not null
      order by seconds asc
    `,
    // The AUCTION WINNER per sold player (the sale's original buyer), so awards
    // credit whoever won the lot - not whoever holds the player after a later
    // trade. price/value/delta are already sale-anchored; this keeps the name
    // anchored to the bid too.
    sql`
      select s.player_id, m.slot, m.short
      from sales s
      join managers m on m.id = s.manager_id
    `,
  ]);

  const byId = new Map(players.players.map((p) => [p.id, p]));
  const buyerByPlayer = new Map(
    buyerRows.map((r) => [r.player_id, { slot: r.slot, short: r.short }]),
  );

  // --- per-manager final squads (always LIVE-derived) ----------------------
  // The recap shows each manager's roster for verification + FPL Draft entry.
  // Rosters are NOT archived (the season_recap snapshot deliberately keeps only
  // leftover/spend/count - see db/schema.sql); they stay derivable from the
  // ledger, so we read them straight off the players assembly above regardless
  // of whether a leftover snapshot exists. SEALING: every squad player is owned,
  // hence sold, so its value/verdict are already unsealed by buildPlayersPayload
  // - no new valuations read, no widening of the seal.
  const POS_ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
  const squads = players.managers
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((m) => ({
      slot: m.slot,
      short: m.short,
      squadCount: m.squadPlayerIds.length,
      players: m.squadPlayerIds
        .map((id) => byId.get(id))
        .filter((p) => p != null)
        // Position order (GK, DEF, MID, FWD) then price desc, matching the
        // manager page's grouping so the same squad reads the same everywhere.
        .sort(
          (a, b) =>
            (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9) ||
            (b.price ?? 0) - (a.price ?? 0),
        )
        .map((p) => ({
          id: p.id,
          // FPL-canonical web_name for entry on draft.premierleague.com; the
          // disambiguated label rides alongside for on-screen clarity (#44).
          webName: p.name,
          displayName: p.displayName ?? p.name,
          teamShort: p.teamShort,
          position: p.position,
          tier: p.tier,
          price: p.price,
          value: p.value,
          verdict: p.verdict,
        })),
    }));

  // --- leftover per manager: archive if present, else live-derived ---------
  const archived = archiveRows.length > 0;
  const managers = archived
    ? archiveRows.map((r) => ({
        slot: r.manager_slot,
        short: r.manager_short,
        spent: num(r.spent),
        leftover: num(r.leftover),
        squadCount: num(r.squad_count),
      }))
    : players.managers
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((m) => ({
          slot: m.slot,
          short: m.short,
          spent: m.spent,
          leftover: m.remaining,
          squadCount: m.squadPlayerIds.length,
        }));
  const archivedAt = archived
    ? archiveRows.reduce((max, r) => {
        const t = new Date(r.created_at).toISOString();
        return t > max ? t : max;
      }, "")
    : null;

  const totalSpent = managers.reduce((s, m) => s + (m.spent ?? 0), 0);
  const totalLeftover = managers.reduce((s, m) => s + (m.leftover ?? 0), 0);

  // --- awards from the ledger ---------------------------------------------
  const sold = players.players.filter((p) => p.sold);
  // delta = price - value (positive = overpay, negative = steal). Only sold
  // rows carry a value, so this never reads a sealed value.
  const valued = sold.filter((p) => p.value != null && p.delta != null);

  /** shape one player into an award entry, crediting the auction winner */
  const entry = (p, extra = {}) => {
    if (p == null) return null;
    const buyer = buyerByPlayer.get(p.id);
    return {
      playerId: p.id,
      name: p.displayName ?? p.name,
      // The original bidder (sale-anchored), falling back to the post-trade
      // owner only if a buyer row is somehow missing.
      ownerSlot: buyer ? buyer.slot : p.ownerSlot,
      ownerShort: buyer ? buyer.short : p.ownerShort,
      price: p.price,
      value: p.value,
      delta: p.delta,
      ...extra,
    };
  };

  let biggestOverpay = null;
  let steal = null;
  for (const p of valued) {
    if (p.delta > 0 && (biggestOverpay == null || p.delta > biggestOverpay.delta)) {
      biggestOverpay = p;
    }
    if (p.delta < 0 && (steal == null || p.delta < steal.delta)) {
      steal = p;
    }
  }

  // Fastest hammer: first row of the ascending-seconds query that we still have
  // a sold player for (a sale could in theory have been voided between queries).
  let fastestHammer = null;
  for (const h of hammerRows) {
    const p = byId.get(h.player_id);
    if (p && p.sold) {
      fastestHammer = entry(p, { seconds: Math.max(0, Math.round(num(h.seconds))) });
      break;
    }
  }

  return {
    season,
    archived,
    archivedAt,
    version: players.version,
    soldCount: sold.length,
    valuedCount: valued.length,
    totalSpent,
    totalLeftover,
    managers,
    // Position quotas (GK/DEF/MID/FWD) so the recap can show per-position
    // completeness (e.g. "GK 2/2") without importing config on the client.
    squad: players.squad,
    squads,
    awards: {
      biggestOverpay: entry(biggestOverpay),
      steal: entry(steal),
      fastestHammer,
    },
    generatedAt: new Date().toISOString(),
  };
}
