// Typed wrapper: binds the pure trades assembly (lib/trades-core.mjs) to the
// app's shared postgres pool and league config. The /api/trades route is a
// thin wrapper over this; scripts/test-trades.mjs drives trades-core directly
// with its own client so the exact same assembly is what gets tested.

import { getConfig } from "./config";
import { sql } from "./db";
import { buildTradesPayload as buildTradesPayloadCore } from "./trades-core.mjs";

/** A manager side of a trade (abbreviated on screen via abbr()). */
export interface TradeManagerRef {
  slot: number;
  short: string;
}

/** One player that moved in a trade. Never carries a value (no sealing). */
export interface TradeMovePlayer {
  id: number;
  /** Disambiguated on-screen label (#44); falls back to webName. */
  name: string | null;
  /** FPL-canonical web_name. */
  webName: string | null;
  teamShort: string | null;
  position: string | null;
}

/** One recorded, non-voided trade. */
export interface TradeRow {
  id: number;
  createdAt: string;
  /** Season-economy stage (#31), e.g. "auction-1". */
  stage: string;
  managerA: TradeManagerRef;
  managerB: TradeManagerRef;
  cashAToB: number;
  cashBToA: number;
  playersAToB: TradeMovePlayer[];
  playersBToA: TradeMovePlayer[];
}

export interface TradesPayload {
  /** Season id from league.config.json. */
  season: string;
  count: number;
  /** Non-voided trades, newest first. */
  trades: TradeRow[];
  generatedAt: string;
}

/** Assemble the full /api/trades payload against the app's pool + config. */
export async function getTradesPayload(): Promise<TradesPayload> {
  return (await buildTradesPayloadCore(sql, getConfig())) as TradesPayload;
}
