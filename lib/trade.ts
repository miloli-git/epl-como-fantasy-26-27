// Typed wrapper: binds the pure trade transaction (lib/trade-core.mjs) to the
// app's shared postgres pool and league config. The /api/trade route is a thin
// wrapper over this; scripts/test-trade.mjs drives trade-core directly with
// its own client so the exact same transaction is what gets tested.

import type { Position } from "./config";
import { getConfig } from "./config";
import { sql } from "./db";
import { recordTrade as recordTradeCore } from "./trade-core.mjs";

export interface TradeRejection {
  ok: false;
  /** Machine-readable rule name, e.g. "negative_budget", "not_owned". */
  code: string;
  /** Plain-English rule, safe to show on the console. */
  message: string;
}

export interface TradeSideResult {
  id: number;
  remaining: number;
  fills: Record<Position, number>;
  openSlots: number;
}

export interface TradeSuccess {
  ok: true;
  tradeId: number;
  createdAt: string;
  managerA: TradeSideResult;
  managerB: TradeSideResult;
}

export type TradeResult = TradeSuccess | TradeRejection;

/** Record a two-sided trade against the app's pool + config. */
export async function recordTrade(args: {
  managerA: number;
  managerB: number;
  playersAToB?: number[];
  playersBToA?: number[];
  cashAToB?: number;
  cashBToA?: number;
  reason?: string;
  actor: string;
}): Promise<TradeResult> {
  return (await recordTradeCore(sql, getConfig(), args)) as TradeResult;
}
