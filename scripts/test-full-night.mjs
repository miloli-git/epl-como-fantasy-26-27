// Scripted FULL-NIGHT auction drill (docs/TEST-PLAN.md criterion 7): drives
// the REAL, full ingested player pool and the REAL managers seeded from
// league.config.json through a complete two-phase auction - phase 1 (queue
// walk: sales + no-bids), endPhaseOne, phase 2 (nomination rotation) - until
// every manager's squad is exactly full. Drives the exact lib/*-core.mjs
// transactions the app's routes serve, same as scripts/test-lot.mjs and
// scripts/test-draft.mjs, but over the WHOLE pool instead of a small fixture
// range (buildQueue/endPhaseOne are whole-pool operations by design, so this
// suite cannot use a fixture id range the way the others do).
//
// Usage: node --env-file=.env scripts/test-full-night.mjs
//   (--env-file must point at a THROWAWAY scratch DB that has already had
//   `npm run db:setup` and `npm run ingest` run against it. NEVER point this
//   at neondb/production - it sells the entire pool to the seeded managers.)
//
// Cleanup: captures an id high-water mark on sales/lot_events/audit_log and
// the full app_state row BEFORE writing anything, and in `finally` deletes
// every row created above those marks (audit_log also scoped to this script's
// actor) and restores app_state exactly - so running this script twice in a
// row against the same scratch DB is safe and reproducible. If setup throws
// before the floors are captured, cleanup SKIPS the id-based deletes rather
// than risk a delete-everything. Managers and players (the pool) are untouched.
//
// SCOPE - what this drill does and does NOT cover:
//   DOES: prove that a complete two-phase night over the WHOLE real pool runs
//   end to end and lands every manager at exactly a full squad, with all the
//   money/ownership/audit invariants intact and agreeing across three sources
//   (in-memory bookkeeping, raw SQL, and the app's own /api/state derivation).
//   DOES NOT: exercise competitive bidding. Every sale here is at the tier's
//   opening bid, so the max-bid boundary, the over-max rejection under real
//   contention, and contested phase-2 nominations are NOT the focus. Those are
//   covered by scripts/test-draft.mjs (over-max + all rejection codes),
//   scripts/test-draft-concurrency.mjs (budget cap under contention), and
//   scripts/test-lot.mjs (nomination rotation + skip-full-squad). This drill
//   adds ONE integration-level over-max rejection check (below) as a smoke
//   test of the money boundary, but the exhaustive rejection coverage lives in
//   those suites, not here.

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig, openBidFor, squadSize } from "../lib/config-core.mjs";
import { recordSale } from "../lib/draft-core.mjs";
import { buildQueue, endPhaseOne, noBid, nominate } from "../lib/lot-core.mjs";
import { deriveManager, isEligible } from "../lib/derive-core.mjs";
import { buildStatePayload } from "../lib/state-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`. " +
      "This must point at a THROWAWAY scratch DB, never production.",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1 });

let local;
try {
  local = JSON.parse(readFileSync("league.config.local.json", "utf8"));
} catch {
  local = undefined;
}
const cfg = buildConfig(JSON.parse(readFileSync("league.config.json", "utf8")), local);
const SIZE = squadSize(cfg);
const POSITIONS = Object.keys(cfg.squad);

const ACTOR = "test-full-night";
// How many open slots per position each manager deliberately keeps open at
// the end of phase 1, so phase 2's nomination rotation always has real work
// to do (per docs/TEST-PLAN.md #7: "sales + no-bids + phase 2"). Config-driven
// (never exceeds a position's own quota).
const PHASE1_RESERVE = 1;

let passCount = 0;
let failCount = 0;
let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) passCount++;
  else {
    failCount++;
    failed = true;
  }
}

function expectReject(name, result, code) {
  report(
    name,
    result && result.ok === false && result.code === code &&
      typeof result.message === "string" && result.message.length > 0,
    result ? `code = ${result.code}, message = "${result.message}"` : "no result",
  );
}

/** Deterministic seeded rng (mulberry32) - same helper as scripts/test-lot.mjs. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- fixture-free fixture management -------------------------------------
// This suite has no id range of its own (it must operate on the whole real
// pool), so cleanup is a pure id high-water mark on every table it can write
// to, plus a full app_state snapshot - identical restore contract to
// scripts/test-lot.mjs / scripts/test-draft.mjs, just without an id filter.

let savedAppState = null;
let createdAppStateRow = false;
let floorsCaptured = false;
let salesFloor = 0;
let lotEventsFloor = 0;
let auditFloor = 0;

async function appStateRow() {
  const [row] = await sql`select * from app_state where id = 1`;
  return row;
}

async function currentVersion() {
  const [{ version }] = await sql`select version from app_state where id = 1`;
  return Number(version);
}

async function cleanup() {
  if (floorsCaptured) {
    await sql`delete from lot_events where id > ${lotEventsFloor}`;
    await sql`delete from sales where id > ${salesFloor}`;
    await sql`delete from audit_log where id > ${auditFloor} and actor = ${ACTOR}`;
  } else {
    // A throw fired before the floors were captured. With floors still at
    // their default 0, an id-based delete would wipe the WHOLE table, so we
    // refuse it. app_state restore below still runs (it is snapshot-based).
    console.error(
      "cleanup: floors were never captured (setup threw early) - SKIPPING row " +
        "deletes to avoid a delete-everything. If this ran against a persistent " +
        "scratch DB, inspect sales/lot_events/audit_log by hand.",
    );
  }
  if (createdAppStateRow) {
    await sql`delete from app_state where id = 1`;
    createdAppStateRow = false;
  } else if (savedAppState) {
    const s = savedAppState;
    await sql`
      update app_state
      set phase = ${s.phase}, paused = ${s.paused},
          current_player_id = ${s.current_player_id}, tv_view = ${s.tv_view},
          reveal_until = ${s.reveal_until},
          nomination_turn = ${s.nomination_turn},
          lot_queue = ${s.lot_queue == null ? null : sql.json(s.lot_queue)},
          pool_frozen = ${s.pool_frozen}, version = ${s.version}
      where id = 1
    `;
    savedAppState = null;
  }
}

/** Same forward-only "next unsold queue entry" scan the engine itself runs
 *  (lib/lot-core.mjs noBid / lib/draft-core.mjs recordSale) - computed locally
 *  from the queue buildQueue returned plus our own up-to-date sold set, so the
 *  phase-1 walk needs no extra round trip to re-read app_state each lot. */
function nextInQueue(queue, currentId, soldSet) {
  const idx = queue.indexOf(currentId);
  for (const id of queue.slice(idx + 1)) {
    if (!soldSet.has(id)) return id;
  }
  return null;
}

try {
  // Capture the cleanup floors FIRST, before anything can write, assigning
  // each immediately after its own query. Only once all three are set do we
  // flip floorsCaptured - so a throw partway through can never leave a floor
  // at its default 0 and turn cleanup's `id > floor` delete into a wipe.
  const [{ f: sf }] = await sql`select coalesce(max(id), 0)::int as f from sales`;
  salesFloor = sf;
  const [{ f: lf }] = await sql`select coalesce(max(id), 0)::int as f from lot_events`;
  lotEventsFloor = lf;
  const [{ f: af }] = await sql`select coalesce(max(id), 0)::int as f from audit_log`;
  auditFloor = af;
  floorsCaptured = true;

  // app_state singleton: create if missing, else capture the WHOLE row.
  const existingState = await appStateRow();
  if (!existingState) {
    await sql`insert into app_state (id) values (1)`;
    createdAppStateRow = true;
  } else {
    savedAppState = existingState;
  }

  // ------------------------------------------------------------------
  // PRECONDITIONS: real managers seeded, real pool ingested, virgin draft.
  // ------------------------------------------------------------------
  const N = cfg.managers.length;
  const managers = await sql`
    select id, slot, short from managers where slot between 1 and ${N} order by slot
  `;
  if (managers.length !== N) {
    throw new Error(
      `Expected ${N} real manager(s) (slots 1..${N}) per league.config.json - found ` +
        `${managers.length}. Run \`npm run db:setup\` against this DB first.`,
    );
  }

  const allPlayerRows = await sql`select id, position, tier from players order by id`;
  if (allPlayerRows.length === 0) {
    throw new Error("players table is empty. Run `npm run ingest` against this DB first.");
  }
  const playersById = new Map(allPlayerRows.map((p) => [p.id, p]));

  for (const pos of POSITIONS) {
    const need = N * cfg.squad[pos];
    const have = allPlayerRows.filter((p) => p.position === pos).length;
    if (have < need) {
      throw new Error(
        `Pool cannot fill every squad: ${N} managers need ${need} ${pos} total, ` +
          `the pool only has ${have}. Aborting rather than looping forever.`,
      );
    }
  }

  const [{ n: preSales }] = await sql`select count(*)::int as n from sales`;
  const [{ n: preLotEvents }] = await sql`select count(*)::int as n from lot_events`;
  // Total lot_events, not just no-bids: buildQueue runs an unconditional
  // `delete from lot_events` (lib/lot-core.mjs), which would silently destroy
  // any pre-existing 'offered'/'nominated' rows below our cleanup floor with no
  // way to restore them. Requiring an empty table up front keeps the header's
  // reproducibility claim honest.
  const virgin = preSales === 0 && preLotEvents === 0;
  report(
    "precondition: pool starts virgin (0 sales, 0 lot_events)",
    virgin,
    `${preSales} sales, ${preLotEvents} lot_events`,
  );
  if (!virgin) {
    throw new Error(
      "Aborting: the pool is not virgin (sales or lot_events already present). Re-run " +
        "db:setup + ingest against this scratch DB, or investigate leftover state from a " +
        "crashed previous run of this script.",
    );
  }

  // ------------------------------------------------------------------
  // In-memory bookkeeping, mirrored 1:1 from successful engine calls only -
  // used to drive the strategy AND as one of the three cross-checked sources
  // of truth at the end (in-memory vs raw DB vs the app's own derivation).
  // ------------------------------------------------------------------
  const ownedByManager = new Map(managers.map((m) => [m.id, []]));
  const soldSet = new Set();
  let actionCount = 0; // every successful buildQueue/recordSale/noBid/endPhaseOne/nominate call
  let phase1Sales = 0;
  let phase1NoBids = 0;
  let phase2Sales = 0;
  let phase2Nominations = 0;

  function phase1Cap(position) {
    return Math.max(0, cfg.squad[position] - Math.min(PHASE1_RESERVE, cfg.squad[position]));
  }
  function phase1Eligible(managerId, position, price) {
    const derived = deriveManager(cfg, ownedByManager.get(managerId));
    if (!isEligible(cfg, derived, position)) return false;
    if (price > derived.maxBid) return false;
    if (derived.fills[position] >= phase1Cap(position)) return false;
    return true;
  }
  let buyerPointer = 0;
  function pickBuyerForPhase1(position, price) {
    for (let i = 0; i < managers.length; i++) {
      const idx = (buyerPointer + i) % managers.length;
      const m = managers[idx];
      if (phase1Eligible(m.id, position, price)) {
        buyerPointer = (idx + 1) % managers.length;
        return m;
      }
    }
    return null;
  }

  // ==================================================================
  // PHASE 1: build the queue and walk it.
  // ==================================================================
  console.log("--- phase 1: buildQueue + walk ---");

  await sql`
    update app_state
    set paused = false, pool_frozen = true, phase = 1,
        current_player_id = null, lot_queue = null, nomination_turn = null,
        tv_view = 'block', reveal_until = null
    where id = 1
  `;

  const initialVersion = await currentVersion();
  const build = await buildQueue(sql, cfg, { actor: ACTOR, rng: mulberry32(424242) });
  report(
    "buildQueue succeeds over the full real pool",
    build.ok === true && build.queue.length === allPlayerRows.length,
    build.ok ? `${build.queue.length} lots` : `${build.code}: ${build.message}`,
  );
  if (!build.ok) throw new Error(`buildQueue failed: ${build.code}: ${build.message}`);
  actionCount++;

  let current = build.firstPlayerId;
  let firstLotChecked = false;
  let sawSealingSpotCheck = false;
  const phase1IterationCap = build.queue.length + 5;
  let phase1Iterations = 0;

  while (current != null) {
    phase1Iterations++;
    if (phase1Iterations > phase1IterationCap) {
      throw new Error(
        `Phase 1 exceeded ${phase1IterationCap} iterations without exhausting the queue ` +
          "(possible infinite loop) - aborting.",
      );
    }
    const player = playersById.get(current);
    if (!player) throw new Error(`Lot ${current} is not in the players table - inconsistent pool.`);
    const openBid = openBidFor(cfg, player.tier);

    if (!firstLotChecked) {
      firstLotChecked = true;
      const versionBefore = await currentVersion();
      const [{ n: salesBefore }] = await sql`select count(*)::int as n from sales`;

      // (a) Below the tier's opening bid (or, for a config whose cheapest tier
      // opens at $1, a non-positive price): must be rejected.
      const illegalPrice = openBid > 1 ? openBid - 1 : 0;
      const belowCode = illegalPrice > 0 ? "below_open" : "bad_price";
      const below = await recordSale(sql, cfg, {
        playerId: current, managerId: managers[0].id, price: illegalPrice, actor: ACTOR,
      });
      expectReject("illegal sale below the opening bid is rejected", below, belowCode);

      // (b) Above the buyer's max bid - the money boundary this app is built
      // around. managers[0] owns nothing yet, so their maxBid is the full
      // budget minus the reserve per open slot; one dollar over must reject.
      const maxBid0 = deriveManager(cfg, ownedByManager.get(managers[0].id)).maxBid;
      const overMax = await recordSale(sql, cfg, {
        playerId: current, managerId: managers[0].id, price: maxBid0 + 1, actor: ACTOR,
      });
      expectReject("sale one dollar over the buyer's max bid is rejected", overMax, "over_max_bid");

      const [{ n: salesAfter }] = await sql`select count(*)::int as n from sales`;
      report(
        "both rejected attempts wrote nothing (version + sales count unchanged)",
        (await currentVersion()) === versionBefore && salesAfter === salesBefore,
      );
    }

    const buyer = pickBuyerForPhase1(player.position, openBid);
    if (buyer) {
      const res = await recordSale(sql, cfg, {
        playerId: current, managerId: buyer.id, price: openBid, actor: ACTOR,
      });
      if (!res.ok) {
        throw new Error(
          `Unexpected phase-1 sale rejection: player ${current} -> ${buyer.short}: ${res.code}: ${res.message}`,
        );
      }
      actionCount++;
      phase1Sales++;
      soldSet.add(current);
      ownedByManager.get(buyer.id).push({ playerId: current, price: openBid, position: player.position });

      if (!sawSealingSpotCheck) {
        sawSealingSpotCheck = true;
        const midState = await buildStatePayload(sql, cfg);
        report(
          "state payload never carries a sealed valuation for the current (unsold) lot",
          midState.currentLot === null || !("value" in midState.currentLot),
        );
      }
    } else {
      const res = await noBid(sql, cfg, { actor: ACTOR });
      if (!res.ok) {
        throw new Error(`Unexpected phase-1 no-bid rejection for player ${current}: ${res.code}: ${res.message}`);
      }
      actionCount++;
      phase1NoBids++;
    }
    current = nextInQueue(build.queue, current, soldSet);
  }

  report(
    "phase 1 queue fully resolved: app_state.current_player_id is null",
    (await appStateRow()).current_player_id === null,
  );
  report(
    "every phase-1 lot resolved to exactly one sale or no-bid",
    phase1Sales + phase1NoBids === build.queue.length,
    `${phase1Sales} sales + ${phase1NoBids} no-bids vs ${build.queue.length} lots`,
  );
  const [{ n: salesAfterPhase1 }] = await sql`select count(*)::int as n from sales where id > ${salesFloor}`;
  const [{ n: noBidsAfterPhase1 }] = await sql`
    select count(*)::int as n from lot_events where event = 'no_bid' and id > ${lotEventsFloor}
  `;
  report(
    "raw DB sale/no-bid counts agree with the in-script tally after phase 1",
    salesAfterPhase1 === phase1Sales && noBidsAfterPhase1 === phase1NoBids,
    `db: ${salesAfterPhase1} sales, ${noBidsAfterPhase1} no-bids`,
  );

  // ==================================================================
  // END PHASE ONE
  // ==================================================================
  console.log("--- endPhaseOne ---");
  const ep = await endPhaseOne(sql, cfg, { actor: ACTOR });
  report(
    "endPhaseOne transitions to phase 2",
    ep.ok === true && (await appStateRow()).phase === 2,
    ep.ok ? `nomination turn = ${ep.nominationTurn}` : `${ep.code}: ${ep.message}`,
  );
  if (!ep.ok) throw new Error(`endPhaseOne failed: ${ep.code}: ${ep.message}`);
  actionCount++;

  // ==================================================================
  // PHASE 2: nomination rotation until every squad is exactly full.
  // ==================================================================
  console.log("--- phase 2: nomination rotation ---");

  const maxPhase2Iterations = SIZE * managers.length * 4;
  let phase2Iterations = 0;

  function allSquadsComplete() {
    return managers.every((m) => deriveManager(cfg, ownedByManager.get(m.id)).squadComplete);
  }

  while (!allSquadsComplete()) {
    phase2Iterations++;
    if (phase2Iterations > maxPhase2Iterations) {
      throw new Error(
        `Phase 2 exceeded ${maxPhase2Iterations} iterations without completing every squad - aborting.`,
      );
    }
    const [{ nomination_turn: turn }] = await sql`select nomination_turn from app_state where id = 1`;
    if (turn == null) {
      throw new Error("app_state.nomination_turn is null but not every squad is complete - aborting.");
    }
    const nominator = managers.find((m) => m.slot === turn);
    if (!nominator) throw new Error(`No manager at nomination slot ${turn}.`);

    const derived = deriveManager(cfg, ownedByManager.get(nominator.id));
    const neededPositions = POSITIONS.filter((pos) => derived.fills[pos] < cfg.squad[pos]);
    if (neededPositions.length === 0) {
      throw new Error(
        `Nomination rotation handed the turn to ${nominator.short} (slot ${turn}) but their squad ` +
          "already reports complete - rotation/derivation inconsistency.",
      );
    }

    let candidate = null;
    for (const pos of neededPositions) {
      const options = allPlayerRows.filter((p) => p.position === pos && !soldSet.has(p.id));
      if (options.length === 0) continue;
      options.sort(
        (a, b) => openBidFor(cfg, a.tier) - openBidFor(cfg, b.tier) || a.id - b.id,
      );
      candidate = options[0];
      break;
    }
    if (!candidate) {
      throw new Error(
        `${nominator.short} (slot ${turn}) needs [${neededPositions.join(", ")}] but the pool has ` +
          "no unsold player left in any of those positions. Aborting rather than looping forever.",
      );
    }

    const price = openBidFor(cfg, candidate.tier);
    const nomRes = await nominate(sql, cfg, {
      playerId: candidate.id, managerSlot: turn, actor: ACTOR,
    });
    if (!nomRes.ok) {
      throw new Error(
        `Unexpected nominate rejection: ${nominator.short} nominating player ${candidate.id}: ` +
          `${nomRes.code}: ${nomRes.message}`,
      );
    }
    actionCount++;
    phase2Nominations++;

    const saleRes = await recordSale(sql, cfg, {
      playerId: candidate.id, managerId: nominator.id, price, actor: ACTOR,
    });
    if (!saleRes.ok) {
      throw new Error(
        `Unexpected phase-2 sale rejection: ${nominator.short} buying their own nomination ` +
          `(player ${candidate.id}): ${saleRes.code}: ${saleRes.message}`,
      );
    }
    actionCount++;
    phase2Sales++;
    soldSet.add(candidate.id);
    ownedByManager.get(nominator.id).push({ playerId: candidate.id, price, position: candidate.position });
  }

  report(
    "phase 2 rotation ran at least once (closes real work, not a phase-1-only night)",
    phase2Nominations > 0 && phase2Sales > 0,
    `${phase2Nominations} nominations, ${phase2Sales} sales`,
  );
  report(
    "every phase-2 nomination resolved to exactly one sale (nominator always buys their own pick)",
    phase2Nominations === phase2Sales,
  );

  // ==================================================================
  // FINAL VERIFICATION - three independent sources of truth: in-memory
  // bookkeeping, raw DB aggregates, and the app's own state derivation.
  // ==================================================================
  console.log("--- final verification ---");

  const rawRows = await sql`
    select s.manager_id, p.position, count(*)::int as n, coalesce(sum(s.price), 0)::int as spend
    from sales s
    join players p on p.id = s.player_id
    where s.id > ${salesFloor}
    group by s.manager_id, p.position
  `;
  const rawByManager = new Map(managers.map((m) => [m.id, { fills: { GK: 0, DEF: 0, MID: 0, FWD: 0 }, spend: 0 }]));
  for (const r of rawRows) {
    const entry = rawByManager.get(r.manager_id);
    if (!entry) continue; // a non-fixture, non-config manager - should not happen
    entry.fills[r.position] = r.n;
    entry.spend += r.spend;
  }

  const finalState = await buildStatePayload(sql, cfg);
  const payloadByManager = new Map(finalState.managers.map((m) => [m.id, m]));

  let allExactlyFull = true;
  let allWithinBudget = true;
  let allAgreeAcrossSources = true;
  for (const m of managers) {
    const raw = rawByManager.get(m.id);
    const totalRaw = POSITIONS.reduce((sum, pos) => sum + raw.fills[pos], 0);
    const inMemory = deriveManager(cfg, ownedByManager.get(m.id));
    const payload = payloadByManager.get(m.id);

    const exactlyFull =
      totalRaw === SIZE && POSITIONS.every((pos) => raw.fills[pos] === cfg.squad[pos]);
    if (!exactlyFull) allExactlyFull = false;

    const withinBudget = raw.spend <= cfg.budget && cfg.budget - raw.spend >= 0;
    if (!withinBudget) allWithinBudget = false;

    const agree =
      inMemory.spent === raw.spend &&
      inMemory.squadComplete === true &&
      payload &&
      payload.spent === raw.spend &&
      payload.remaining === cfg.budget - raw.spend &&
      payload.squadComplete === true &&
      POSITIONS.every((pos) => inMemory.fills[pos] === raw.fills[pos]);
    if (!agree) {
      allAgreeAcrossSources = false;
      console.log(
        `  mismatch for ${m.short}: raw=${JSON.stringify(raw)} inMemory=${JSON.stringify(inMemory)} ` +
          `payload=${JSON.stringify(payload)}`,
      );
    }
  }

  report(
    `every manager's squad is EXACTLY full (${SIZE} total, quotas ${JSON.stringify(cfg.squad)})`,
    allExactlyFull,
  );
  report("no manager's spend exceeds budget (remaining >= 0 for all)", allWithinBudget);
  report(
    "derived state (in-memory bookkeeping + /api/state derivation) agrees with raw DB counts for every manager",
    allAgreeAcrossSources,
  );

  const [{ total, distinctN }] = await sql`
    select count(*)::int as total, count(distinct player_id)::int as "distinctN"
    from sales where id > ${salesFloor}
  `;
  report("sales.player_id is unique across the whole night", total === distinctN, `${total} sales, ${distinctN} distinct players`);
  report(
    "total sales sold == managers x full squad size",
    total === managers.length * SIZE,
    `${total} sales vs ${managers.length * SIZE} expected`,
  );

  const finalVersion = await currentVersion();
  report(
    "app_state.version advanced monotonically, by exactly one per state-changing action",
    finalVersion - initialVersion === actionCount,
    `version ${initialVersion} -> ${finalVersion} (delta ${finalVersion - initialVersion}), ${actionCount} actions`,
  );

  const [{ n: auditRows }] = await sql`
    select count(*)::int as n from audit_log where actor = ${ACTOR} and id > ${auditFloor}
  `;
  report(
    "every mutation wrote exactly one audit row (audit_log count == action count)",
    auditRows === actionCount,
    `${auditRows} audit rows vs ${actionCount} actions`,
  );

  // --- summary ---------------------------------------------------------
  const totalSpend = [...rawByManager.values()].reduce((sum, m) => sum + m.spend, 0);
  console.log("\n=== FULL NIGHT SUMMARY ===");
  console.log(`players sold: ${total} (phase 1: ${phase1Sales}, phase 2: ${phase2Sales})`);
  console.log(`no-bids: ${phase1NoBids} (all in phase 1; every phase-2 nomination was awarded)`);
  console.log(`total spend: $${totalSpend} across ${managers.length} managers (budget $${cfg.budget} each)`);
  for (const m of managers) {
    const raw = rawByManager.get(m.id);
    const totalRaw = POSITIONS.reduce((sum, pos) => sum + raw.fills[pos], 0);
    console.log(
      `  ${m.short} (slot ${m.slot}): ${totalRaw}/${SIZE} squad ` +
        `[${POSITIONS.map((p) => `${p} ${raw.fills[p]}/${cfg.squad[p]}`).join(", ")}], ` +
        `$${raw.spend} spent, $${cfg.budget - raw.spend} remaining`,
    );
  }
  console.log(`\nPASS ${passCount} / FAIL ${failCount}`);
} catch (err) {
  console.error("test-full-night failed to run:", err);
  failed = true;
} finally {
  try {
    await cleanup();
  } catch (err) {
    console.error("cleanup failed:", err.message);
    failed = true;
  }
  await sql.end();
}

process.exit(failed ? 1 : 0);
