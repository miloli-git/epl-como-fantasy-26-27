// The lot engine: queue build, no-bid advance, pause/resume, TV override,
// phase transition and phase-2 nominations (02-SPEC §E/§F, 01-CONTEXT
// decisions 5 + 6). Plain JS (with JSDoc types) so scripts/test-lot.mjs can
// drive the exact same transactions the POST /api/lot route serves, without a
// build step. lib/lot.ts wraps these with the app's shared pool and config.
//
// EVERY mutation here runs inside withAuctionLock (lib/draft-core.mjs): the
// FOR UPDATE on the app_state singleton serialises all auction writes, so a
// lot action can never interleave with a sale or a correction. Every mutation
// writes an audit row and bumps app_state.version; rule violations return
// structured rejections ({ok:false, code, message}) and never write anything.
//
// PHASE-2 TURN DESIGN (decision 6: fixed rotation, skip full squads):
// app_state.nomination_turn always points at the manager slot whose turn it
// is to nominate NEXT. endPhaseOne seeds it with the first eligible slot;
// nominate validates the caller against it and then advances it to the next
// eligible slot (skipping squad-complete managers, wrapping past the highest
// slot back to the lowest). Because the turn advances at nomination time, a
// phase-2 no-bid needs NO turn logic (the turn already moved on), and
// recordSale (committed, untouchable) needs none either. Known v1 trade-off:
// undoing a phase-2 sale leaves the turn advanced - the commissioner can live
// with that for one night; revisit if it bites.

import { squadSize } from "./config-core.mjs";
import { withAuctionLock } from "./draft-core.mjs";
import { deriveManager, resolveOwnership } from "./derive-core.mjs";
import { loadOwnershipContext } from "./ownership-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */

/**
 * @typedef {Object} LotRejection
 * @property {false} ok
 * @property {string} code    machine-readable rule name
 * @property {string} message plain-English rule + number, console-displayable
 */

export const TV_VIEWS = ["block", "reveal", "squads", "ledger", "paused"];

/** @param {string} code @param {string} message @returns {LotRejection} */
function reject(code, message) {
  return { ok: false, code, message };
}

/** The shared "draft not initialised" rejection (same wording as draft-core). */
function noState() {
  return reject(
    "no_state",
    "The draft has not been initialised (app_state is empty). Run the seed first.",
  );
}

/** One audit row per state change; every function here writes exactly one. */
async function audit(tx, actor, action, before, after) {
  await tx`
    insert into audit_log (actor, action, entity, entity_id, before, after)
    values (${actor}, ${action}, 'app_state', 1,
            ${before == null ? null : tx.json(before)},
            ${after == null ? null : tx.json(after)})
  `;
}

/**
 * Next running lot number: greatest lot_no seen anywhere (sales OR
 * lot_events) + 1. Identical to the phase-2 numbering in draft-core's
 * recordSale so sales and nominations share one running count.
 */
async function nextLotNo(tx) {
  const [{ next }] = await tx`
    select greatest(
      coalesce((select max(lot_no) from sales), 0),
      coalesce((select max(lot_no) from lot_events), 0)
    ) + 1 as next
  `;
  return Number(next);
}

/**
 * Every manager (slot order) with their squad-complete flag, derived inside
 * the transaction with the exact same logic the board and recordSale use.
 *
 * @returns {Promise<Array<{slot: number, short: string, complete: boolean}>>}
 */
async function managerCompleteness(tx, cfg) {
  const managers = await tx`select id, slot, short from managers order by slot`;
  // Ownership resolved THROUGH trades (#15): a manager who traded a player
  // away no longer owns it, so their squad is no longer counted complete and
  // the phase-2 rotation stops skipping them. squadComplete is a pure slot
  // count, so trade cash is irrelevant here and not loaded.
  const { sales, movements } = await loadOwnershipContext(tx);
  const ownership = resolveOwnership(sales, movements);
  return managers.map((m) => ({
    slot: m.slot,
    short: m.short,
    complete: deriveManager(cfg, ownership.filter((o) => o.managerId === m.id)).squadComplete,
  }));
}

/**
 * The next eligible nomination slot AFTER `afterSlot` in the fixed rotation:
 * the lowest eligible slot greater than afterSlot, wrapping to the lowest
 * eligible slot overall. Null when no manager has an open squad.
 *
 * @param {Array<{slot: number, complete: boolean}>} managers  slot-ordered
 * @param {number} afterSlot
 * @returns {number | null}
 */
function nextEligibleSlot(managers, afterSlot) {
  const eligible = managers.filter((m) => !m.complete).map((m) => m.slot);
  if (eligible.length === 0) return null;
  return eligible.find((s) => s > afterSlot) ?? eligible[0];
}

/**
 * In-place Fisher-Yates shuffle driven by an injected rng so the shuffle is
 * testable (seeded rng in scripts/test-lot.mjs). Never SQL random().
 *
 * @template T @param {T[]} arr @param {() => number} rng @returns {T[]}
 */
function fisherYates(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build the phase-1 lot queue (decision 5: FPL price descending = tier
 * ascending, SHUFFLED within tier): every player, tier 1 group first, each
 * tier group Fisher-Yates shuffled in JS. Requires the pool to be frozen
 * (tiers are snapshotted at freeze - building earlier would bake in stale
 * tiers) and zero sales (rebuilding mid-draft would corrupt lot numbering).
 * With zero sales the previous build's offer history is void, so lot_events
 * is cleared before the first 'offered' row is written.
 *
 * Sets lot_queue, current_player_id = queue[0], phase 1, tv 'block', clears
 * nomination_turn, logs 'offered' for the first lot.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {LeagueConfig} cfg            unused today; kept for signature parity
 * @param {{actor: string, rng?: () => number}} args
 * @returns {Promise<{ok: true, queue: number[], firstPlayerId: number} | LotRejection>}
 */
export async function buildQueue(sql, cfg, { actor, rng = Math.random }) {
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) return noState();
    if (appState.paused) {
      return reject("paused", "The auction is paused. Resume before building the queue.");
    }
    if (!appState.pool_frozen) {
      return reject(
        "pool_not_frozen",
        "Freeze the pool first - the lot queue snapshots tiers at freeze time.",
      );
    }
    const [{ n: saleCount }] = await tx`select count(*)::int as n from sales`;
    if (saleCount > 0) {
      return reject(
        "sales_exist",
        `Cannot rebuild the lot queue: ${saleCount} sale(s) are already recorded.`,
      );
    }
    // Zero sales is not enough: a recorded no-bid means the room has already
    // started working through lots. Stale 'offered'/'nominated' rows from a
    // previous build are void and get cleared below, but a 'no_bid' row is
    // REAL offer history - a rebuild would erase it.
    const [{ n: noBidCount }] = await tx`
      select count(*)::int as n from lot_events where event = 'no_bid'
    `;
    if (noBidCount > 0) {
      return reject(
        "auction_started",
        `The auction has already started (${noBidCount} no-bid lot(s) on record); a rebuild would erase real offer history.`,
      );
    }

    // Tier ascending (nulls last, defensively - a frozen pool has no null
    // tiers), stable id order inside each band before the shuffle.
    const players = await tx`select id, tier from players order by tier asc nulls last, id`;
    if (players.length === 0) {
      return reject("empty_pool", "No players in the pool - run the ingest first.");
    }

    /** @type {Array<{tier: number | null, ids: number[]}>} */
    const groups = [];
    for (const p of players) {
      const last = groups[groups.length - 1];
      if (!last || last.tier !== p.tier) groups.push({ tier: p.tier, ids: [p.id] });
      else last.ids.push(p.id);
    }
    const queue = [];
    for (const g of groups) queue.push(...fisherYates(g.ids, rng));
    const firstPlayerId = queue[0];

    await tx`delete from lot_events`;
    await tx`
      insert into lot_events (player_id, event, lot_no, phase)
      values (${firstPlayerId}, 'offered', 1, 1)
    `;
    await tx`
      update app_state
      set phase = 1,
          current_player_id = ${firstPlayerId},
          lot_queue = ${tx.json(queue)},
          tv_view = 'block',
          reveal_until = null,
          nomination_turn = null,
          version = version + 1
      where id = 1
    `;
    await audit(tx, actor, "lot.build_queue", null, {
      players: queue.length,
      tiers: groups.map((g) => ({ tier: g.tier, count: g.ids.length })),
      firstPlayerId,
    });
    return { ok: true, queue, firstPlayerId };
  });
}

/**
 * Mark the current lot NO BID (decision 6: the player stays available for
 * phase 2, no ad-hoc requeue) and advance.
 *
 * Phase 1: advance to the next UNSOLD queue entry AFTER the current one and
 * log it 'offered'. The scan is strictly forward (queue.slice(queueIdx + 1)),
 * so earlier no-bid players are behind the cursor and are never re-offered in
 * phase 1 - "every player offered once" holds without tracking offers.
 * NOTE: this advance is a deliberate DUPLICATE of the advance inside
 * recordSale (lib/draft-core.mjs, step (c)) - draft-core is committed and
 * this workstream must not touch it. Keep the two in lockstep.
 * TODO(S2): factor the shared advance helper into one place.
 *
 * Phase 2: clear the block. No turn logic - nomination_turn already advanced
 * when the lot was nominated (see the turn design note at the top).
 *
 * tv_view is left alone (it is already 'block' between hammers).
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {LeagueConfig} cfg            unused today; kept for signature parity
 * @param {{actor: string}} args
 * @returns {Promise<{ok: true, playerId: number, lotNo: number | null,
 *   nextPlayerId: number | null, phase: number} | LotRejection>}
 */
export async function noBid(sql, cfg, { actor }) {
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) return noState();
    if (appState.paused) {
      return reject("paused", "The auction is paused. Resume before marking a no-bid.");
    }
    const playerId = appState.current_player_id;
    if (playerId == null) {
      return reject("no_lot", "No player is on the block right now.");
    }

    const phase = appState.phase;
    // Same jsonb Number() normalisation as draft-core: a string id would
    // dodge the sold-set check below.
    const queue = (Array.isArray(appState.lot_queue) ? appState.lot_queue : []).map(Number);
    const queueIdx = queue.indexOf(playerId);

    // lot_no: phase-1 lots are numbered by queue position; a phase-2
    // nominated lot reuses its nomination's running lot_no.
    let lotNo;
    if (queueIdx >= 0) {
      lotNo = queueIdx + 1;
    } else {
      const [nom] = await tx`
        select lot_no from lot_events
        where player_id = ${playerId} and event = 'nominated'
        order by id desc limit 1
      `;
      lotNo = nom ? nom.lot_no : await nextLotNo(tx);
    }

    await tx`
      insert into lot_events (player_id, event, lot_no, phase)
      values (${playerId}, 'no_bid', ${lotNo}, ${phase})
    `;

    // Advance (phase 1): duplicated from draft-core recordSale - see the
    // function comment. Forward-only, skipping SOLD players; earlier no-bids
    // are behind the cursor by construction.
    let nextPlayerId = null;
    if (phase === 1 && queue.length > 0) {
      const soldRows = await tx`select player_id from sales`;
      const soldIds = new Set(soldRows.map((r) => r.player_id));
      for (const id of queue.slice(queueIdx + 1)) {
        if (!soldIds.has(id)) {
          nextPlayerId = id;
          break;
        }
      }
      if (nextPlayerId != null) {
        await tx`
          insert into lot_events (player_id, event, lot_no, phase)
          values (${nextPlayerId}, 'offered', ${queue.indexOf(nextPlayerId) + 1}, ${phase})
        `;
      }
    }

    await tx`
      update app_state
      set current_player_id = ${nextPlayerId}, version = version + 1
      where id = 1
    `;
    await audit(
      tx,
      actor,
      "lot.no_bid",
      { currentPlayerId: playerId },
      { playerId, lotNo, phase, nextPlayerId },
    );
    return { ok: true, playerId, lotNo, nextPlayerId, phase };
  });
}

/**
 * Pause the auction: paused = true, TV shows the paused card.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {{actor: string}} args
 * @returns {Promise<{ok: true} | LotRejection>}
 */
export async function pause(sql, { actor }) {
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) return noState();
    if (appState.paused) {
      return reject("already_paused", "The auction is already paused.");
    }
    await tx`
      update app_state
      set paused = true, tv_view = 'paused', version = version + 1
      where id = 1
    `;
    await audit(
      tx,
      actor,
      "auction.pause",
      { paused: false, tvView: appState.tv_view },
      { paused: true, tvView: "paused" },
    );
    return { ok: true };
  });
}

/**
 * Resume the auction: paused = false, TV back to the block. Any reveal timer
 * that was pending when the pause hit is dropped (its moment has passed).
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {{actor: string}} args
 * @returns {Promise<{ok: true} | LotRejection>}
 */
export async function resume(sql, { actor }) {
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) return noState();
    if (!appState.paused) {
      return reject("not_paused", "The auction is not paused.");
    }
    await tx`
      update app_state
      set paused = false, tv_view = 'block', reveal_until = null,
          version = version + 1
      where id = 1
    `;
    await audit(
      tx,
      actor,
      "auction.resume",
      { paused: true, tvView: appState.tv_view },
      { paused: false, tvView: "block" },
    );
    return { ok: true };
  });
}

/**
 * Console TV override: point the room's screen at any view. A manual override
 * PERSISTS until changed, so reveal_until is always cleared here - the
 * read-time expiry in state-core only applies to sale-set reveals (recordSale
 * stores an expiry instant; a console-set 'reveal' deliberately has none).
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {{view: string, actor: string}} args
 * @returns {Promise<{ok: true, view: string} | LotRejection>}
 */
export async function setTv(sql, { view, actor }) {
  if (!TV_VIEWS.includes(view)) {
    return reject(
      "bad_view",
      `tv view must be one of ${TV_VIEWS.join(", ")} (got ${JSON.stringify(view)}).`,
    );
  }
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) return noState();
    await tx`
      update app_state
      set tv_view = ${view}, reveal_until = null, version = version + 1
      where id = 1
    `;
    await audit(tx, actor, "tv.set", { tvView: appState.tv_view }, { tvView: view });
    return { ok: true, view };
  });
}

/**
 * End phase one (decision 6: manual trigger, only once every player has been
 * offered). The check: no unsold player may lack ANY lot_events row - a
 * player with an 'offered'/'no_bid' row has been offered, a sold player was
 * obviously offered, so zero event-less unsold players means the queue is
 * exhausted. Then: phase = 2, block cleared, lot_queue cleared (phase 2 is
 * nomination-driven; clearing it makes recordSale's lot numbering fall
 * through to the running count for ALL phase-2 lots, and kills the up-next
 * column naturally), nomination_turn = first eligible slot in the fixed
 * rotation (skipping complete squads).
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {LeagueConfig} cfg
 * @param {{actor: string}} args
 * @returns {Promise<{ok: true, nominationTurn: number} | LotRejection>}
 */
export async function endPhaseOne(sql, cfg, { actor }) {
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) return noState();
    if (appState.paused) {
      return reject("paused", "The auction is paused. Resume before ending phase one.");
    }
    if (appState.phase !== 1) {
      return reject("wrong_phase", "Phase one has already ended.");
    }
    // A lot on the block is unresolved business: ending the phase now would
    // strand it (phase 2 clears the queue and numbering falls through to the
    // running count). Resolve it first.
    if (appState.current_player_id != null) {
      return reject(
        "lot_open",
        "A lot is still on the block - resolve it (sale or no bid) before ending phase one.",
      );
    }
    const [{ n: unoffered }] = await tx`
      select count(*)::int as n
      from players p
      where not exists (select 1 from sales s where s.player_id = p.id)
        and not exists (select 1 from lot_events e where e.player_id = p.id)
    `;
    if (unoffered > 0) {
      return reject(
        "players_unoffered",
        `${unoffered} player${unoffered === 1 ? " has" : "s have"} not been offered yet - phase one is not finished.`,
      );
    }

    const managers = await managerCompleteness(tx, cfg);
    const firstEligible = managers.find((m) => !m.complete);
    if (!firstEligible) {
      const size = squadSize(cfg);
      return reject(
        "auction_complete",
        `Every squad is complete (${size}/${size}) - the auction is over, there is nothing left to nominate.`,
      );
    }

    await tx`
      update app_state
      set phase = 2,
          current_player_id = null,
          lot_queue = ${null},
          nomination_turn = ${firstEligible.slot},
          version = version + 1
      where id = 1
    `;
    await audit(
      tx,
      actor,
      "phase.end_one",
      { phase: 1 },
      { phase: 2, nominationTurn: firstEligible.slot, firstNominator: firstEligible.short },
    );
    return { ok: true, nominationTurn: firstEligible.slot };
  });
}

/**
 * Phase-2 nomination (decision 6: fixed rotation, any UNSOLD player is
 * nominable - including phase-1 no-bids and players already nominated and
 * passed on). Validates the caller's slot against the rotation, puts the
 * player on the block, logs 'nominated' (running lot_no), then advances
 * nomination_turn to the next eligible slot (see the turn design note at the
 * top of this file).
 *
 * The expected turn is re-derived defensively: if the stored turn-holder's
 * squad completed since the turn was set (e.g. a corrected sale), the
 * rotation skips forward past them at read time - no state is written on a
 * rejection.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {LeagueConfig} cfg
 * @param {{playerId: number, managerSlot: number, actor: string}} args
 * @returns {Promise<{ok: true, playerId: number, lotNo: number,
 *   managerSlot: number, nominationTurn: number | null} | LotRejection>}
 */
export async function nominate(sql, cfg, { playerId, managerSlot, actor }) {
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) return noState();
    if (appState.paused) {
      return reject("paused", "The auction is paused. Resume before nominating.");
    }
    if (appState.phase !== 2) {
      return reject("wrong_phase", "Nominations only happen in phase two. End phase one first.");
    }
    if (appState.nomination_turn == null) {
      return reject("no_turn", "No nomination turn is set - end phase one first.");
    }
    if (appState.current_player_id != null) {
      return reject(
        "lot_open",
        `Player ${appState.current_player_id} is still on the block - resolve that lot (sale or no-bid) before the next nomination.`,
      );
    }
    if (!Number.isInteger(managerSlot)) {
      return reject(
        "bad_slot",
        `managerSlot must be a whole number (got ${JSON.stringify(managerSlot)}).`,
      );
    }

    const managers = await managerCompleteness(tx, cfg);
    const stored = appState.nomination_turn;
    const storedEntry = managers.find((m) => m.slot === stored);
    const expected =
      storedEntry && !storedEntry.complete ? stored : nextEligibleSlot(managers, stored);
    if (expected == null) {
      const size = squadSize(cfg);
      return reject(
        "auction_complete",
        `Every squad is complete (${size}/${size}) - there is nothing left to nominate.`,
      );
    }
    if (managerSlot !== expected) {
      const holder = managers.find((m) => m.slot === expected);
      return reject(
        "not_your_turn",
        `It is ${holder ? holder.short : `slot ${expected}`}'s turn to nominate (slot ${expected}).`,
      );
    }

    const [player] = await tx`
      select id, web_name from players where id = ${playerId}
    `;
    if (!player) {
      return reject("unknown_player", `No player with id ${playerId} exists in the pool.`);
    }
    const [sold] = await tx`
      select s.price, m.short
      from sales s join managers m on m.id = s.manager_id
      where s.player_id = ${playerId}
    `;
    if (sold) {
      return reject(
        "already_sold",
        `${String(player.web_name).toUpperCase()} is already sold to ${sold.short} for $${sold.price}.`,
      );
    }

    const lotNo = await nextLotNo(tx);
    await tx`
      insert into lot_events (player_id, event, lot_no, phase)
      values (${playerId}, 'nominated', ${lotNo}, 2)
    `;

    // Advance the turn NOW (acceptance time). The nominator's own squad is
    // unchanged by nominating, so `managers` computed above is still current.
    const nextTurn = nextEligibleSlot(managers, expected);
    await tx`
      update app_state
      set current_player_id = ${playerId},
          tv_view = 'block',
          reveal_until = null,
          nomination_turn = ${nextTurn},
          version = version + 1
      where id = 1
    `;
    await audit(
      tx,
      actor,
      "lot.nominate",
      { nominationTurn: stored, currentPlayerId: null },
      { playerId, playerName: player.web_name, managerSlot, lotNo, nextTurn },
    );
    return { ok: true, playerId, lotNo, managerSlot, nominationTurn: nextTurn };
  });
}
