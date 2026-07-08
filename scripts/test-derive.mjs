// Unit tests for lib/derive-core.mjs (pure logic, no DB).
// Usage: node scripts/test-derive.mjs
import { buildConfig } from "../lib/config-core.mjs";
import {
  deriveManager,
  deriveManagers,
  gradingTertiles,
  isEligible,
  poolCounts,
  resolveOwnership,
  saleVerdict,
  scarcityAlerts,
  tradeCashByManager,
} from "../lib/derive-core.mjs";

// Same shape as league.config.json (budget 3000, minOpenBid 5) so the mockup
// fixtures line up. Built through buildConfig so it is a validated config.
const cfg = buildConfig({
  season: "test",
  sport: "epl",
  managers: ["A", "B", "C", "D", "E", "F", "G", "H"],
  budget: 3000,
  squad: { GK: 2, DEF: 5, MID: 5, FWD: 3 },
  tiers: [
    { tier: 1, minFplPrice: 12.0, openBid: 50 },
    { tier: 2, minFplPrice: 9.0, openBid: 25 },
    { tier: 3, minFplPrice: 7.0, openBid: 10 },
    { tier: 4, minFplPrice: 0, openBid: 5 },
  ],
  bidIncrement: null,
  valueBadgeThreshold: 50,
  scarcityThreshold: 2,
  pollMs: 2000,
  revealMs: 8000,
});

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  report(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Build `count` owned rows for one manager summing to `total` spent, with the
// given positions cycled through.
let nextPlayerId = 1;
function ownedRows(managerId, count, total, positions) {
  const base = Math.floor(total / count);
  const rows = [];
  let allocated = 0;
  for (let i = 0; i < count; i++) {
    const price = i === count - 1 ? total - allocated : base;
    allocated += price;
    rows.push({
      playerId: nextPlayerId++,
      managerId,
      price,
      position: positions[i % positions.length],
    });
  }
  return rows;
}

// --- mockup fixtures: maxBid = remaining - minOpenBid * (openSlots - 1) ---

// remaining 1210, 5 open slots (10 owned, spent 1790) -> maxBid 1190
{
  const owned = ownedRows(1, 10, 1790, ["GK", "GK", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID"]);
  const d = deriveManager(cfg, owned);
  eq("maxBid: remaining 1210, 5 open -> 1190", [d.remaining, d.openSlots, d.maxBid], [1210, 5, 1190]);
}

// remaining 983, 2 open slots (13 owned, spent 2017) -> maxBid 978
{
  const d = deriveManager(cfg, ownedRows(2, 13, 2017, ["GK", "GK", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "MID", "FWD"]));
  eq("maxBid: remaining 983, 2 open -> 978", [d.remaining, d.openSlots, d.maxBid], [983, 2, 978]);
}

// remaining 333, 8 open slots (7 owned, spent 2667) -> maxBid 298
{
  const d = deriveManager(cfg, ownedRows(3, 7, 2667, ["GK", "DEF", "DEF", "MID", "MID", "FWD", "FWD"]));
  eq("maxBid: remaining 333, 8 open -> 298", [d.remaining, d.openSlots, d.maxBid], [333, 8, 298]);
}

// full squad (15 owned) -> maxBid null, squadComplete
{
  const d = deriveManager(cfg, ownedRows(4, 15, 2900, ["GK", "GK", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "MID", "FWD", "FWD", "FWD"]));
  eq("maxBid: full squad -> null + squadComplete", [d.maxBid, d.squadComplete, d.openSlots], [null, true, 0]);
}

// --- eligibility: FWD quota filled -> ineligible FWD, eligible MID ---
{
  const d = deriveManager(cfg, ownedRows(5, 5, 500, ["FWD", "FWD", "FWD", "GK", "DEF"]));
  eq("eligibility: FWD quota full -> not eligible for FWD", isEligible(cfg, d, "FWD"), false);
  eq("eligibility: same manager still eligible for MID", isEligible(cfg, d, "MID"), true);
}

// --- deriveManagers: a manager with no purchases gets a full clean row ---
{
  const managers = [{ id: 10, slot: 1, short: "M1" }, { id: 11, slot: 2, short: "M2" }];
  const ownership = resolveOwnership(ownedRows(10, 1, 100, ["MID"]));
  const [m1, m2] = deriveManagers(cfg, managers, ownership);
  eq("deriveManagers: buyer numbers", [m1.spent, m1.remaining, m1.openSlots], [100, 2900, 14]);
  eq("deriveManagers: empty manager numbers", [m2.spent, m2.remaining, m2.openSlots, m2.maxBid], [0, 3000, 15, 3000 - 5 * 14]);
}

// --- resolveOwnership: trade folding (issues #15/#18) ---
// Two sold players; a trade moves one of them. Salary travels with the player.
{
  const sales = [
    { playerId: 100, managerId: 1, price: 500, position: "MID" },
    { playerId: 101, managerId: 2, price: 300, position: "FWD" },
  ];
  const own = resolveOwnership(sales, [
    { playerId: 100, fromManager: 1, toManager: 2, seq: 1 },
  ]);
  const byPlayer = Object.fromEntries(own.map((o) => [o.playerId, o]));
  eq("trade folding: player 100 now owned by manager 2", byPlayer[100].managerId, 2);
  eq("trade folding: salary travels unchanged ($500)", byPlayer[100].price, 500);
  eq("trade folding: manager 1 owns nothing now", own.filter((o) => o.managerId === 1).length, 0);
}

// Chain A->B then B->C lands on C, regardless of input order.
{
  const sales = [{ playerId: 100, managerId: 1, price: 500, position: "MID" }];
  const movements = [
    { playerId: 100, fromManager: 2, toManager: 3, seq: 2 },
    { playerId: 100, fromManager: 1, toManager: 2, seq: 1 },
  ];
  const own = resolveOwnership(sales, movements);
  eq("trade folding: chain 1->2->3 lands on 3 (input unordered)", own[0].managerId, 3);
}

// A movement for a player with no sale row is ignored (cannot trade an unsold player).
{
  const sales = [{ playerId: 100, managerId: 1, price: 500, position: "MID" }];
  const own = resolveOwnership(sales, [
    { playerId: 999, fromManager: 1, toManager: 2, seq: 1 },
  ]);
  eq("trade folding: movement for unsold player ignored", [own.length, own[0].managerId], [1, 1]);
}

// --- tradeCashByManager: net cash in spend terms, both directions ---
{
  // manager 1 pays 200 to manager 2; separately manager 2 pays 50 to manager 1.
  const net = tradeCashByManager([
    { managerA: 1, managerB: 2, cashAToB: 200, cashBToA: 0 },
    { managerA: 2, managerB: 1, cashAToB: 50, cashBToA: 0 },
  ]);
  // manager 1: paid 200, received 50 -> net out 150. manager 2: mirror -> -150.
  eq("tradeCash: net cash out per manager", [net[1], net[2]], [150, -150]);
}

// --- deriveManager: cashOut folds into spend ---
{
  const owned = ownedRows(1, 1, 500, ["MID"]);
  const d = deriveManager(cfg, owned, 150); // paid 150 net cash out
  eq("deriveManager: cashOut adds to spend", [d.spent, d.remaining], [650, 2350]);
  const r = deriveManager(cfg, owned, -200); // received 200 net cash
  eq("deriveManager: cash received lifts remaining", [r.spent, r.remaining], [300, 2700]);
}

// --- integration: salary travel + cash, conserved across both managers ---
// manager 1 trades its $500 player to manager 2 for $200 cash (2 pays 1).
{
  const managers = [{ id: 1, slot: 1, short: "M1" }, { id: 2, slot: 2, short: "M2" }];
  const sales = [
    { playerId: 100, managerId: 1, price: 500, position: "MID" },
    { playerId: 101, managerId: 2, price: 300, position: "FWD" },
  ];
  const trades = [{ managerA: 1, managerB: 2, cashAToB: 0, cashBToA: 200 }];
  const ownership = resolveOwnership(sales, [
    { playerId: 100, fromManager: 1, toManager: 2, seq: 1 },
  ]);
  const cash = tradeCashByManager(trades);
  const [m1, m2] = deriveManagers(cfg, managers, ownership, cash);
  // manager 1: no players, received $200 -> spent -200, remaining 3200, 15 open.
  eq("integration: seller after trade", [m1.spent, m1.remaining, m1.openSlots], [-200, 3200, 15]);
  // manager 2: owns both salaries ($800) + paid $200 -> spent 1000, remaining 2000, 13 open.
  eq("integration: buyer after trade", [m2.spent, m2.remaining, m2.openSlots], [1000, 2000, 13]);
  // conservation: remaining sums unchanged by the trade (5200 before and after).
  eq("integration: total remaining conserved", m1.remaining + m2.remaining, 5200);
}

// --- tertiles: known 6-sale fixture ---
// deltas (value - price) / price: 1.0, 0.5, 0, -0.1, -0.5, 0.3
// sorted: [-0.5, -0.1, 0, 0.3, 0.5, 1.0]; n=6 -> lower=idx1=-0.1, upper=idx3=0.3
{
  const sales = [
    { price: 100, value: 200 },
    { price: 100, value: 150 },
    { price: 100, value: 100 },
    { price: 100, value: 90 },
    { price: 100, value: 50 },
    { price: 100, value: 130 },
  ];
  eq("tertiles: 6-sale fixture boundaries", gradingTertiles(sales), { lower: -0.1, upper: 0.3, count: 6 });
}

// tertiles: fewer than 3 sales with a value -> null
{
  eq("tertiles: <3 sales -> null", gradingTertiles([{ price: 100, value: 120 }, { price: 50, value: 40 }, { price: 10, value: null }]), null);
}

// --- scarcity: fires at the config threshold, not above, not at zero ---
{
  const unsold = [
    // FWD tier 1: exactly 2 (== scarcityThreshold) -> alert
    { position: "FWD", tier: 1 },
    { position: "FWD", tier: 1 },
    // MID tier 2: 3 (> threshold) -> no alert
    { position: "MID", tier: 2 },
    { position: "MID", tier: 2 },
    { position: "MID", tier: 2 },
    // GK tier 2: exactly 1 -> singular alert
    { position: "GK", tier: 2 },
    // DEF tier 1: 0 -> no alert; tier 3/4 stock never alerts
    { position: "DEF", tier: 3 },
    { position: "DEF", tier: 4 },
  ];
  const pool = poolCounts(cfg, unsold);
  eq("poolCounts: FWD tier grid", pool.FWD, { 1: 2, 2: 0, 3: 0, 4: 0 });
  const alerts = scarcityAlerts(cfg, pool);
  eq("scarcity: fires at threshold with plain wording", alerts.sort(), [
    "Only 1 Tier-2 goalkeeper remains",
    "Only 2 Tier-1 forwards remain",
  ]);
}

// --- scarcity: alerting tiers are config-driven via scarcityTiers ---
{
  const cfgTier3 = { ...cfg, scarcityTiers: [1, 2, 3] };
  const unsold = [
    // DEF tier 3: exactly 1 -> alerts only when tier 3 is configured to alert
    { position: "DEF", tier: 3 },
    // FWD tier 4: 1, but tier 4 is not in scarcityTiers -> never alerts
    { position: "FWD", tier: 4 },
  ];
  const pool = poolCounts(cfg, unsold);
  eq("scarcity: scarcityTiers [1,2,3] fires a tier-3 alert", scarcityAlerts(cfgTier3, pool), [
    "Only 1 Tier-3 defender remains",
  ]);
  // Default config (no scarcityTiers key) keeps the [1, 2] behaviour.
  eq("scarcity: default tiers stay silent on tier 3", scarcityAlerts(cfg, pool), []);
}

// --- v1 verdict logic ---
{
  eq("verdict: overpay", saleVerdict(cfg, 800, 560), { delta: 240, pctOver: 240 / 560, verdict: "OVERPAY" });
  eq("verdict: steal", saleVerdict(cfg, 100, 300), { delta: -200, pctOver: -200 / 300, verdict: "STEAL" });
  eq("verdict: fair within band", saleVerdict(cfg, 150, 120), { delta: 30, pctOver: 30 / 120, verdict: "FAIR" });
  eq("verdict: no valuation -> nulls", saleVerdict(cfg, 150, null), { delta: null, pctOver: null, verdict: null });
}

process.exit(failed ? 1 : 0);
