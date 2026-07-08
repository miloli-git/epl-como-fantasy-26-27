// The no-oversell sale transaction (repo issue #4) - THE correctness-critical
// write of the whole product. Plain JS (with JSDoc types) so the integration
// and concurrency tests (scripts/test-draft*.mjs) can drive the exact same
// transaction the route serves, without a build step. lib/draft.ts wraps it
// with the app's shared pool and config.
//
// CONCURRENCY DESIGN: every sale runs inside ONE sql.begin transaction whose
// first statement is `select ... from app_state where id = 1 for update`.
// app_state is a singleton row, so this is a single-row lock that serialises
// ALL sales: concurrent writers queue on the lock and each one re-reads the
// world AFTER the previous writer committed. Simple and bulletproof at our
// scale (one commissioner writing, 8 managers, one sale every ~90 seconds);
// no serializable-isolation retry loops needed. The UNIQUE(player_id)
// constraint on sales remains the final backstop against a double-sale, and
// a 23505 from it is converted into the same already-sold rejection.

import { minOpenBid, openBidFor, squadSize } from "./config-core.mjs";
import { deriveManager, isEligible, resolveOwnership, tradeCashByManager } from "./derive-core.mjs";
import { loadOwnershipContext } from "./ownership-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */

/**
 * @typedef {Object} SaleRejection
 * @property {false} ok
 * @property {string} code    machine-readable rule name
 * @property {string} message plain-English rule + number, console-displayable
 */

/**
 * @typedef {Object} SaleSuccess
 * @property {true} ok
 * @property {{id: number, playerId: number, playerName: string, managerId: number,
 *            managerShort: string, price: number, lotNo: number | null,
 *            phase: number, createdAt: string}} sale
 * @property {string} revealUntil  sale.createdAt + cfg.revealMs (ISO), also
 *                                 persisted to app_state.reveal_until; clients
 *                                 use it to time the reveal takeover.
 */

/** @param {string} code @param {string} message @returns {SaleRejection} */
function reject(code, message) {
  return { ok: false, code, message };
}

/**
 * THE serialising lock for ALL auction mutations. Opens a transaction whose
 * first statement locks the app_state singleton row FOR UPDATE, then hands
 * (tx, appState) to fn. Every writer that mutates auction state (sales, lot
 * advance, tv_view, phase, ...) must run inside this helper so concurrent
 * writers queue on the single-row lock and each one re-reads the world AFTER
 * the previous writer committed.
 *
 * @template T
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {(tx: import("postgres").TransactionSql, appState: any) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withAuctionLock(sql, fn) {
  return await sql.begin(async (tx) => {
    const [appState] = await tx`
      select * from app_state where id = 1 for update
    `;
    return fn(tx, appState);
  });
}

/**
 * Record a sale: validate every legality rule inside the serialising
 * transaction, insert the sale + audit row, advance the lot, flip the TV to
 * the reveal and bump the state version. Returns a structured result; never
 * throws for a rule violation (only for infrastructure failures).
 *
 * @param {import("postgres").Sql} sql  a postgres.js client (pool)
 * @param {LeagueConfig} cfg
 * @param {{playerId: number, managerId: number, price: number, actor: string}} args
 * @returns {Promise<SaleSuccess | SaleRejection>}
 */
export async function recordSale(sql, cfg, { playerId, managerId, price, actor }) {
  try {
    return await withAuctionLock(sql, async (tx, appState) => {
      // (a) withAuctionLock holds the serialising lock. Everything below sees
      // a world no other sale transaction is mutating.
      if (!appState) {
        return reject(
          "no_state",
          "The draft has not been initialised (app_state is empty). Run the seed first.",
        );
      }
      if (appState.paused) {
        return reject("paused", "The auction is paused. Resume before recording a sale.");
      }
      // The sold player must be the lot on the block. In phase 2 a nomination
      // also sets app_state.current_player_id (POST /api/lot nominate), so
      // this same check covers validly nominated phase-2 lots; if nomination
      // ever stops setting current_player_id, extend this to consult
      // lot_events('nominated') instead.
      if (appState.current_player_id !== playerId) {
        return reject(
          "wrong_lot",
          appState.current_player_id == null
            ? "No player is on the block right now."
            : `Player ${playerId} is not the current lot (player ${appState.current_player_id} is on the block).`,
        );
      }

      // (b) Load everything post-lock, then validate in order.
      const [player] = await tx`
        select id, web_name, position, tier from players where id = ${playerId}
      `;
      if (!player) {
        return reject("unknown_player", `No player with id ${playerId} exists in the pool.`);
      }

      const [existing] = await tx`
        select s.price, m.short
        from sales s join managers m on m.id = s.manager_id
        where s.player_id = ${playerId}
      `;
      if (existing) {
        return reject(
          "already_sold",
          `${String(player.web_name).toUpperCase()} is already sold to ${existing.short} for $${existing.price}.`,
        );
      }

      const [manager] = await tx`
        select id, slot, short from managers where id = ${managerId}
      `;
      if (!manager) {
        return reject("unknown_manager", `No manager with id ${managerId} exists.`);
      }

      // The buyer's current squad, read inside the transaction (post-lock),
      // derived with the exact same logic the board uses. Resolved GLOBALLY
      // through trades: a player traded TO this buyer (recorded on someone
      // else's sales row) counts toward their squad and its salary, and trade
      // cash moves their remaining - so max-bid/quota/squad-size validate
      // against the buyer's TRUE post-trade position, not just their own
      // purchases. With no trades this is identical to the old per-manager read.
      const ctx = await loadOwnershipContext(tx);
      const ownership = resolveOwnership(ctx.sales, ctx.movements);
      const cash = tradeCashByManager(ctx.trades);
      const derived = deriveManager(
        cfg,
        ownership.filter((o) => o.managerId === managerId),
        cash[managerId] || 0,
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

      if (typeof price !== "number" || !Number.isInteger(price) || price <= 0) {
        return reject(
          "bad_price",
          `Price must be a positive whole number of dollars (got ${JSON.stringify(price)}).`,
        );
      }
      const openBid = player.tier != null ? openBidFor(cfg, player.tier) : minOpenBid(cfg);
      if (price < openBid) {
        return reject(
          "below_open",
          `Below the Tier ${player.tier ?? "?"} opening bid ($${openBid}).`,
        );
      }
      // maxBid reserves the league minimum opening bid per OTHER open slot;
      // derived inside the transaction so it reflects the post-lock truth.
      if (derived.maxBid != null && price > derived.maxBid) {
        return reject(
          "over_max_bid",
          `Over ${manager.short}'s max bid of $${derived.maxBid} - they must keep $${minOpenBid(cfg)} per open slot. Rejected.`,
        );
      }

      // (c) All legal - write the sale.
      const phase = appState.phase;
      // lot_queue lives in jsonb, so normalise every entry with Number() at
      // read time: a string id from any future writer would dodge the sold-set
      // membership check below and re-offer a sold player.
      const queue = (Array.isArray(appState.lot_queue) ? appState.lot_queue : []).map(Number);
      const queueIdx = queue.indexOf(playerId);
      // lot_no: phase 1 lots are numbered by queue position. A phase-2 sale
      // resolves the nomination that put the player on the block, so it
      // REUSES that nomination's running lot_no - one lot = one number
      // (lot-core's noBid does exactly the same for a passed nomination).
      // Only when no nomination event exists (defensive: a lot placed on the
      // block by hand) fall back to the running max + 1.
      let lotNo;
      if (queueIdx >= 0) {
        lotNo = queueIdx + 1;
      } else {
        const [nom] = await tx`
          select lot_no from lot_events
          where player_id = ${playerId} and event = 'nominated'
          order by id desc limit 1
        `;
        if (nom && nom.lot_no != null) {
          lotNo = Number(nom.lot_no);
        } else {
          const [{ next }] = await tx`
            select greatest(
              coalesce((select max(lot_no) from sales), 0),
              coalesce((select max(lot_no) from lot_events), 0)
            ) + 1 as next
          `;
          lotNo = Number(next);
        }
      }

      const [sale] = await tx`
        insert into sales (player_id, manager_id, price, lot_no, phase)
        values (${playerId}, ${managerId}, ${price}, ${lotNo}, ${phase})
        returning id, player_id, manager_id, price, lot_no, phase, created_at
      `;

      await tx`
        insert into audit_log (actor, action, entity, entity_id, before, after)
        values (
          ${actor}, 'sale.create', 'sale', ${sale.id}, ${null},
          ${tx.json({
            player: player.web_name,
            playerId,
            manager: manager.short,
            managerId,
            price,
            lot: lotNo,
            phase,
          })}
        )
      `;

      // Advance the lot. Phase 1: pop the queue to the next UNSOLD player
      // and log that it is now offered. Phase 2: clear the block - the next
      // nomination (rotation) sets current_player_id again.
      let nextPlayerId = null;
      if (phase === 1 && queue.length > 0) {
        // Sold set includes the sale just inserted (same transaction).
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

      // Reveal expiry is a stored instant: computed here in JS (created_at +
      // revealMs) and persisted so state assembly can expire the reveal
      // deterministically at read time. NULL reveal_until means "persist
      // until changed" (the console's set_tv override writes that).
      const createdAt = new Date(sale.created_at);
      const revealUntil = new Date(createdAt.getTime() + cfg.revealMs);

      await tx`
        update app_state
        set current_player_id = ${nextPlayerId},
            tv_view = 'reveal',
            reveal_until = ${revealUntil.toISOString()},
            version = version + 1
        where id = 1
      `;
      return {
        ok: true,
        sale: {
          id: sale.id,
          playerId: sale.player_id,
          playerName: player.web_name,
          managerId: sale.manager_id,
          managerShort: manager.short,
          price: sale.price,
          lotNo: sale.lot_no,
          phase: sale.phase,
          createdAt: createdAt.toISOString(),
        },
        // Mirrors the app_state.reveal_until instant written above; state
        // assembly (state-core) reports tvView='block' once it passes.
        revealUntil: revealUntil.toISOString(),
      };
    });
  } catch (err) {
    // The UNIQUE(player_id) backstop: if two writers somehow raced past the
    // lock (they can't, but belt AND braces), the constraint fires and we
    // return the same already-sold rejection instead of a 500.
    if (err && err.code === "23505") {
      const [existing] = await sql`
        select s.price, m.short, p.web_name
        from sales s
        join managers m on m.id = s.manager_id
        join players p on p.id = s.player_id
        where s.player_id = ${playerId}
      `;
      return reject(
        "already_sold",
        existing
          ? `${String(existing.web_name).toUpperCase()} is already sold to ${existing.short} for $${existing.price}.`
          : `Player ${playerId} is already sold.`,
      );
    }
    throw err;
  }
}
