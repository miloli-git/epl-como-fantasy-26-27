// Typed wrapper: binds the pure players assembly (lib/players-core.mjs) to the
// app's shared postgres pool and league config. The /api/players route is a
// thin wrapper over this; scripts/test-players.mjs drives players-core directly
// with its own client so the exact same assembly is what gets tested.

import type { Position } from "./config";
import { getConfig } from "./config";
import { sql } from "./db";
import type { Verdict } from "./derive";
import { buildPlayersPayload as buildPlayersPayloadCore } from "./players-core.mjs";

export interface PlayerRow {
  id: number;
  /** FPL photo code for the face thumbnail (null if unknown). */
  code: number | null;
  /** Raw FPL web_name. */
  name: string | null;
  /** Unique on-screen label (#44): web_name, or "web_name (CLUB)" when shared. */
  displayName: string | null;
  teamShort: string | null;
  /** Badge code for the club crest (null if unknown). */
  teamCode: number | null;
  position: Position;
  tier: number | null;
  fplPrice: number | null;
  pts: number | null;
  sold: boolean;
  /** Current owner (post-trade). Null for unsold players. */
  ownerSlot: number | null;
  ownerShort: string | null;
  /** Salary paid (travels with the player through trades). Null if unsold. */
  price: number | null;
  /** Sealed Claude value - present ONLY on sold rows (structural, see core). */
  value: number | null;
  delta: number | null;
  verdict: Verdict | null;
  /** Passed over with no bid and still unsold (the ledger's NO BID marker). */
  noBid: boolean;
}

export interface PlayersManager {
  id: number;
  slot: number;
  short: string;
  spent: number;
  remaining: number;
  openSlots: number;
  squadComplete: boolean;
  maxBid: number | null;
  /** Currently-owned player ids (post-trade), oldest-first. */
  squadPlayerIds: number[];
  /** Sum of the sealed values of owned players (all sold). Null if none valued. */
  claudeValue: number | null;
  /** claudeValue - spent. Null when claudeValue is null. */
  claudeDelta: number | null;
}

export interface PlayersPayload {
  version: number;
  players: PlayerRow[];
  managers: PlayersManager[];
  /** Per-position squad quota (from config). */
  squad: Record<Position, number>;
  pollMs: number;
  generatedAt: string;
}

/** Assemble the full /api/players payload against the app's pool + config. */
export async function getPlayersPayload(): Promise<PlayersPayload> {
  return (await buildPlayersPayloadCore(sql, getConfig())) as PlayersPayload;
}
