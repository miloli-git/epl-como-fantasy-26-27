// Sale corrections (undo last / edit any / void any) - the commissioner's
// fix-it tools per 02-SPEC §E/§F and 04-DATA-MODEL. Plain JS (with JSDoc
// types) so scripts/test-corrections.mjs can drive the exact same
// transactions the routes serve, without a build step. lib/corrections.ts
// wraps these with the app's shared pool and config.
//
// EVERY mutation here runs inside withAuctionLock (lib/draft-core.mjs): the
// FOR UPDATE on the app_state singleton serialises all auction writes, so a
// correction can never interleave with a sale (see the comment on app_state
// in db/schema.sql). Every mutation writes an audit row and bumps
// app_state.version; rule violations return structured rejections
// ({ok:false, code, message}) and never write anything (the transaction only
// performs writes after all checks pass).

import { minOpenBid, openBidFor, squadSize } from "./config-core.mjs";
import { withAuctionLock } from "./draft-core.mjs";
import { deriveManager, isEligible, resolveOwnership } from "./derive-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */

/**
 * @typedef {Object} CorrectionRejection
 * @property {false} ok
 * @property {string} code    machine-readable rule name
 * @property {string} message plain-English rule + number, console-displayable
 */

/**
 * @typedef {Object} SaleSnapshot  a sale row as it stood (audit payload shape)
 * @property {number} id
 * @property {number} player_id
 * @property {number} manager_id
 * @property {number} price
 * @property {number | null} lot_no
 * @property {number | null} phase
 * @property {string} created_at   ISO instant
 */

/** @param {string} code @param {string} message @returns {CorrectionRejection} */
function reject(code, message) {
  return { ok: false, code, message };
}

/** @param {unknown} reason */
function missingReason(reason) {
  return typeof reason !== "string" || reason.trim() === "";
}

/**
 * Snapshot a sales row into the audit payload shape (snake_case row fields,
 * created_at as an ISO string so before/after JSON is stable and comparable).
 *
 * @param {any} row @returns {SaleSnapshot}
 */
function snapshot(row) {
  return {
    id: row.id,
    player_id: row.player_id,
    manager_id: row.manager_id,
    price: row.price,
    lot_no: row.lot_no,
    phase: row.phase,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * Undo the MOST RECENT sale (by created_at, tiebreak id): delete the row,
 * write a 'sale.void' audit entry (reason "undo last sale", before = the
 * deleted row), and restore the board - the undone player goes straight back
 * on the block (current_player_id), tv_view returns to 'block' and any
 * pending reveal is cancelled (reveal_until = null).
 *
 * QUEUE RESTORATION (verified against draft-core.mjs): the lot advance in
 * recordSale is DERIVED, not stored - after a sale it scans
 * lot_queue.slice(queueIdx + 1) for the first player NOT in the sold set
 * (a fresh `select player_id from sales`). So putting current_player_id back
 * to the undone player is enough: the queue itself was never mutated, the
 * deleted row leaves the sold set, and when the restored lot sells again the
 * same scan lands on the same next player as before (still unsold). The
 * previously-advanced lot simply becomes "next" again. Phase-2 lots are not
 * queue-driven at all, so restoring current_player_id covers them too.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {LeagueConfig} cfg            unused today; kept for signature parity
 * @param {{actor: string}} args
 * @returns {Promise<{ok: true, undone: SaleSnapshot} | CorrectionRejection>}
 */
export async function undoLastSale(sql, cfg, { actor }) {
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) {
      return reject(
        "no_state",
        "The draft has not been initialised (app_state is empty). Run the seed first.",
      );
    }

    const [last] = await tx`
      select id, player_id, manager_id, price, lot_no, phase, created_at
      from sales
      order by created_at desc, id desc
      limit 1
    `;
    if (!last) {
      return reject("nothing_to_undo", "No sale to undo.");
    }

    const before = snapshot(last);
    await tx`delete from sales where id = ${last.id}`;

    await tx`
      insert into audit_log (actor, action, entity, entity_id, before, after, reason)
      values (${actor}, 'sale.void', 'sale', ${last.id}, ${tx.json(before)}, ${null},
              'undo last sale')
    `;

    // The natural behaviour the room expects: the player goes back on the
    // block, and the TV drops any in-flight reveal of the now-undone sale.
    await tx`
      update app_state
      set current_player_id = ${last.player_id},
          tv_view = 'block',
          reveal_until = null,
          version = version + 1
      where id = 1
    `;

    return { ok: true, undone: before };
  });
}

/**
 * Edit any sale: change its manager and/or price, re-validating the FULL
 * legality of the sale in the new state. The buying manager's derived
 * numbers (quota, squad size, max bid) are recomputed EXCLUDING this sale
 * itself - otherwise the sale's own current price would be double-counted in
 * spend when raising the price, and its own slot would wrongly block a
 * same-manager edit. reason is REQUIRED, and at least one of managerId/price
 * must be provided (else 'nothing_to_change').
 *
 * Does not touch current_player_id or tv_view: editing an old sale does not
 * change what's on the block.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {LeagueConfig} cfg
 * @param {{saleId: number, managerId?: number, price?: number, reason: string, actor: string}} args
 * @returns {Promise<{ok: true, sale: SaleSnapshot, before: SaleSnapshot} | CorrectionRejection>}
 */
export async function editSale(sql, cfg, { saleId, managerId, price, reason, actor }) {
  if (missingReason(reason)) {
    return reject("missing_reason", "A reason is required to edit a sale.");
  }
  if (managerId === undefined && price === undefined) {
    return reject("nothing_to_change", "Nothing to change.");
  }
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) {
      return reject(
        "no_state",
        "The draft has not been initialised (app_state is empty). Run the seed first.",
      );
    }

    const [sale] = await tx`
      select id, player_id, manager_id, price, lot_no, phase, created_at
      from sales where id = ${saleId}
    `;
    if (!sale) {
      return reject("not_found", `Sale #${saleId} not found.`);
    }

    const newManagerId = managerId ?? sale.manager_id;
    const newPrice = price ?? sale.price;

    const [player] = await tx`
      select id, web_name, position, tier from players where id = ${sale.player_id}
    `;
    if (!player) {
      // A sale row always references a real player (FK); belt and braces.
      return reject("unknown_player", `No player with id ${sale.player_id} exists in the pool.`);
    }

    const [manager] = await tx`
      select id, slot, short from managers where id = ${newManagerId}
    `;
    if (!manager) {
      return reject("unknown_manager", `No manager with id ${newManagerId} exists.`);
    }

    // The buying manager's squad EXCLUDING the sale being edited: the edit
    // replaces this sale wholesale, so its current price must not count in
    // spend and its slot must not count as filled (else lowering-then-raising
    // a price double-counts, and a same-manager edit can never pass a full
    // quota it itself fills).
    const ownedRows = await tx`
      select s.player_id, s.manager_id, s.price, p.position
      from sales s join players p on p.id = s.player_id
      where s.manager_id = ${newManagerId} and s.id <> ${saleId}
    `;
    const derived = deriveManager(
      cfg,
      resolveOwnership(
        ownedRows.map((r) => ({
          playerId: r.player_id,
          managerId: r.manager_id,
          price: r.price,
          position: r.position,
        })),
      ),
    );

    const size = squadSize(cfg);
    if (derived.squadComplete) {
      return reject(
        "squad_complete",
        `${manager.short} has a complete squad (${size}/${size}).`,
      );
    }
    if (!isEligible(cfg, derived, player.position)) {
      const quota = cfg.squad[player.position];
      return reject(
        "position_full",
        `${manager.short} has no open ${player.position} slot (${derived.fills[player.position]}/${quota}).`,
      );
    }

    if (typeof newPrice !== "number" || !Number.isInteger(newPrice) || newPrice <= 0) {
      return reject(
        "bad_price",
        `Price must be a positive whole number of dollars (got ${JSON.stringify(newPrice)}).`,
      );
    }
    const openBid = player.tier != null ? openBidFor(cfg, player.tier) : minOpenBid(cfg);
    if (newPrice < openBid) {
      return reject(
        "below_open",
        `Below the Tier ${player.tier ?? "?"} opening bid ($${openBid}).`,
      );
    }
    if (derived.maxBid != null && newPrice > derived.maxBid) {
      return reject(
        "over_max_bid",
        `Over ${manager.short}'s max bid of $${derived.maxBid} - they must keep $${minOpenBid(cfg)} per open slot. Rejected.`,
      );
    }

    const before = snapshot(sale);
    const [updated] = await tx`
      update sales
      set manager_id = ${newManagerId}, price = ${newPrice}
      where id = ${saleId}
      returning id, player_id, manager_id, price, lot_no, phase, created_at
    `;
    const after = snapshot(updated);

    await tx`
      insert into audit_log (actor, action, entity, entity_id, before, after, reason)
      values (${actor}, 'sale.edit', 'sale', ${saleId},
              ${tx.json(before)}, ${tx.json(after)}, ${reason.trim()})
    `;

    await tx`update app_state set version = version + 1 where id = 1`;

    return { ok: true, sale: after, before };
  });
}

/**
 * Void any sale: delete the row (the player becomes available again - the
 * UNIQUE(player_id) constraint then allows a later re-sale), write a
 * 'sale.void' audit entry with the deleted row and the required reason, bump
 * the version. reason is REQUIRED.
 *
 * Deliberately does NOT touch current_player_id: voiding an old sale doesn't
 * change what's on the block. The semantics stay distinct from undoLastSale
 * on purpose (undo = "that hammer was wrong, put the player back up"; void =
 * "strike this sale from the record, the auction rolls on").
 *
 * ONE exception on tv_view: if the voided sale is the NEWEST sale (created_at
 * desc, id desc - the same ordering undoLastSale uses) AND the TV is mid
 * reveal, the reveal on screen is THIS sale's reveal. Leaving it running
 * would replay a now-voided sale to the room (and once it expires the TV
 * would fall back showing stale data), so we cancel it: tv_view = 'block',
 * reveal_until = null. Voiding any OLDER sale leaves the TV alone - the
 * running reveal belongs to a different, still-valid sale.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {LeagueConfig} cfg            unused today; kept for signature parity
 * @param {{saleId: number, reason: string, actor: string}} args
 * @returns {Promise<{ok: true, voided: SaleSnapshot} | CorrectionRejection>}
 */
export async function voidSale(sql, cfg, { saleId, reason, actor }) {
  if (missingReason(reason)) {
    return reject("missing_reason", "A reason is required to void a sale.");
  }
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) {
      return reject(
        "no_state",
        "The draft has not been initialised (app_state is empty). Run the seed first.",
      );
    }

    const [sale] = await tx`
      select id, player_id, manager_id, price, lot_no, phase, created_at
      from sales where id = ${saleId}
    `;
    if (!sale) {
      return reject("not_found", `Sale #${saleId} not found.`);
    }

    // Is this the newest sale? (Checked BEFORE the delete, same ordering as
    // undoLastSale.) If so and the TV is mid-reveal, that reveal is showing
    // THIS sale - clear it below so the room never sees a voided sale's
    // reveal keep playing (or the previous sale's reveal replay).
    const [newest] = await tx`
      select id from sales
      order by created_at desc, id desc
      limit 1
    `;
    const voidingRevealedSale =
      newest != null && newest.id === sale.id && appState.tv_view === "reveal";

    const before = snapshot(sale);
    await tx`delete from sales where id = ${saleId}`;

    await tx`
      insert into audit_log (actor, action, entity, entity_id, before, after, reason)
      values (${actor}, 'sale.void', 'sale', ${saleId},
              ${tx.json(before)}, ${null}, ${reason.trim()})
    `;

    if (voidingRevealedSale) {
      await tx`
        update app_state
        set tv_view = 'block', reveal_until = null, version = version + 1
        where id = 1
      `;
    } else {
      await tx`update app_state set version = version + 1 where id = 1`;
    }

    return { ok: true, voided: before };
  });
}
