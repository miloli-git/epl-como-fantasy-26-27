// Typed wrapper: binds the pure state assembly (lib/state-core.mjs) to the
// app's shared postgres pool and league config. The /api/state route is a
// thin wrapper over this; scripts/test-state.mjs drives state-core directly
// with its own client so the exact same assembly is what gets tested.

import type { Position } from "./config";
import { getConfig } from "./config";
import { sql } from "./db";
import type { PoolCounts, Tertiles, Verdict } from "./derive";
import { buildStatePayload as buildStatePayloadCore } from "./state-core.mjs";

export interface CurrentLot {
  id: number;
  code: number | null;
  name: string;
  firstName: string | null;
  secondName: string | null;
  teamId: number | null;
  teamShort: string | null;
  teamCode: number | null;
  position: Position;
  fplPrice: number | null;
  tier: number | null;
  openBid: number | null;
  stats: {
    pts: number | null;
    goals: number | null;
    assists: number | null;
    bonus: number | null;
    starts: number | null;
    minutes: number | null;
    cleanSheets: number | null;
    saves: number | null;
    pensMissed: number | null;
    yellows: number | null;
    reds: number | null;
    selectedBy: number | null;
  };
  overallRank: number | null;
  positionRank: number | null;
  age: number | null;
  nationality: string | null;
  heightCm: number | null;
  prevComoOwner: string | null;
  prevComoPrice: number | null;
  brief: unknown | null;
}

export interface SquadEntry {
  playerId: number;
  name: string;
  position: Position;
  tier: number | null;
  price: number;
}

export interface ManagerState {
  /** DB manager id - what /api/draft expects as managerId. */
  id: number;
  slot: number;
  short: string;
  spent: number;
  remaining: number;
  fills: Record<Position, number>;
  openSlots: number;
  maxBid: number | null;
  squadComplete: boolean;
  squad: SquadEntry[];
}

export interface RecentSale {
  /** Sale row id - what the undo double-submit guard sends as expectedSaleId. */
  saleId: number;
  playerId: number;
  playerName: string;
  position: Position;
  tier: number | null;
  managerShort: string | null;
  price: number;
  lotNo: number | null;
  value: number | null;
  delta: number | null;
  verdict: Verdict | null;
  createdAt: string;
}

export interface Reveal {
  /** Sale row id: with createdAt, lets clients dedupe reveals. */
  saleId: number;
  playerId: number;
  playerName: string;
  managerShort: string | null;
  price: number;
  value: number | null;
  delta: number | null;
  pctOver: number | null;
  verdict: Verdict | null;
  createdAt: string;
}

export interface UpNextEntry {
  id: number;
  name: string;
  tier: number | null;
}

export interface StatePayload {
  version: number;
  phase: number;
  paused: boolean;
  tvView: string;
  currentLot: CurrentLot | null;
  upNext: UpNextEntry[];
  nominationTurn: number | null;
  recentSales: RecentSale[];
  managers: ManagerState[];
  pool: PoolCounts;
  scarcity: string[];
  grading: Tertiles | null;
  reveal: Reveal | null;
  pollMs: number;
  revealMs: number;
  generatedAt: string;
}

/** Assemble the full /api/state payload against the app's pool + config. */
export async function getStatePayload(): Promise<StatePayload> {
  return (await buildStatePayloadCore(sql, getConfig())) as StatePayload;
}
