// Typed wrapper around the pure derivation module. The logic itself lives in
// lib/derive-core.mjs (plain JS with JSDoc types) so plain node scripts and
// tests can exercise the exact same code without a build step - same pattern
// as lib/config.ts over lib/config-core.mjs.

import type { LeagueConfig, Position } from "./config";
import {
  deriveManager as deriveManagerCore,
  deriveManagers as deriveManagersCore,
  gradingTertiles as gradingTertilesCore,
  isEligible as isEligibleCore,
  poolCounts as poolCountsCore,
  resolveOwnership as resolveOwnershipCore,
  saleVerdict as saleVerdictCore,
  scarcityAlerts as scarcityAlertsCore,
  tradeCashByManager as tradeCashByManagerCore,
} from "./derive-core.mjs";

export interface OwnedPlayer {
  playerId: number;
  managerId: number;
  /** The salary the player carries (sale price; travels through trades). */
  price: number;
  position: Position;
}

export interface TradeMovement {
  playerId: number;
  fromManager: number;
  toManager: number;
  /** Chronological order key; higher = later. Latest movement wins. */
  seq: number;
}

export interface TradeCashRow {
  managerA: number;
  managerB: number;
  cashAToB: number;
  cashBToA: number;
}

export interface ManagerDerived {
  spent: number;
  remaining: number;
  fills: Record<Position, number>;
  openSlots: number;
  squadComplete: boolean;
  /** null when the squad is complete. */
  maxBid: number | null;
}

export interface ManagerRow {
  id: number;
  slot: number;
  short: string;
}

export type PoolCounts = Record<Position, Record<number, number>>;

export interface Tertiles {
  lower: number;
  upper: number;
  count: number;
}

export type Verdict = "OVERPAY" | "FAIR" | "STEAL";

export interface VerdictResult {
  delta: number | null;
  pctOver: number | null;
  verdict: Verdict | null;
}

/**
 * Resolve current ownership. Sales rows are deleted on void, so every existing
 * sales row is a current ownership; trade movements then MOVE ownership (the
 * salary travels with the player). Pass only non-voided movements.
 */
export function resolveOwnership(
  saleRows: OwnedPlayer[],
  tradeMovements: TradeMovement[] = [],
): OwnedPlayer[] {
  return resolveOwnershipCore(saleRows, tradeMovements) as OwnedPlayer[];
}

/** Net trade cash per manager in spend terms (positive = paid out). */
export function tradeCashByManager(
  tradeRows: TradeCashRow[],
): Record<number, number> {
  return tradeCashByManagerCore(tradeRows) as Record<number, number>;
}

export function deriveManager(
  cfg: LeagueConfig,
  owned: OwnedPlayer[],
  cashOut = 0,
): ManagerDerived {
  return deriveManagerCore(cfg, owned, cashOut) as ManagerDerived;
}

export function deriveManagers(
  cfg: LeagueConfig,
  managers: ManagerRow[],
  ownership: OwnedPlayer[],
  cashByManager: Record<number, number> = {},
): Array<ManagerRow & ManagerDerived & { managerId: number }> {
  return deriveManagersCore(cfg, managers, ownership, cashByManager) as Array<
    ManagerRow & ManagerDerived & { managerId: number }
  >;
}

/** Eligible to bid on `position`: quota slot open AND a squad slot open. */
export function isEligible(
  cfg: LeagueConfig,
  derived: ManagerDerived,
  position: Position,
): boolean {
  return isEligibleCore(cfg, derived, position) as boolean;
}

export function poolCounts(
  cfg: LeagueConfig,
  unsoldPlayers: Array<{ position: Position; tier: number | null }>,
): PoolCounts {
  return poolCountsCore(cfg, unsoldPlayers) as PoolCounts;
}

export function scarcityAlerts(
  // scarcityTiers (which tiers raise alerts) is read leniently by the core and
  // defaults to [1, 2]; widened here because LeagueConfig lives in a committed
  // workstream (lib/config.ts).
  cfg: LeagueConfig & { scarcityTiers?: number[] },
  pool: PoolCounts,
): string[] {
  return scarcityAlertsCore(cfg, pool) as string[];
}

/** Tertile boundaries of (value - price) / price; null when < 3 sales. */
export function gradingTertiles(
  sales: Array<{ price: number; value: number | null }>,
): Tertiles | null {
  return gradingTertilesCore(sales) as Tertiles | null;
}

/** v1 verdict logic (see derive-core for the marked rule). */
export function saleVerdict(
  cfg: LeagueConfig,
  price: number,
  value: number | null,
): VerdictResult {
  return saleVerdictCore(cfg, price, value) as VerdictResult;
}
