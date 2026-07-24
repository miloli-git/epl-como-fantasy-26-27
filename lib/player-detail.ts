// Typed wrapper: binds the pure single-player assembly
// (lib/player-detail-core.mjs) to the app's shared postgres pool and league
// config. The /api/player/[id] route is a thin wrapper over this;
// scripts/test-player-detail.mjs drives player-detail-core directly with its
// own client so the exact same assembly is what gets tested.

import type { Position } from "./config";
import { getConfig } from "./config";
import { sql } from "./db";
import type { Verdict } from "./derive";
import { buildPlayerDetailPayload as buildPlayerDetailPayloadCore } from "./player-detail-core.mjs";

/** The read-only spotlight fields - the board's "on the block" card MINUS all
 * bidding data. NOTE: there is deliberately no `value`/`openBid` here; the
 * sealed valuation lives only on {@link PlayerSale}, present only when sold. */
export interface PlayerDetail {
  id: number;
  code: number | null;
  /** Raw FPL web_name. */
  name: string;
  /** Unique on-screen label (#44): web_name, or "web_name (CLUB)" when shared. */
  displayName: string;
  firstName: string | null;
  secondName: string | null;
  teamId: number | null;
  teamShort: string | null;
  teamCode: number | null;
  position: Position;
  fplPrice: number | null;
  tier: number | null;
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

/** The sale result for a SOLD player (#51). Null on the payload unless sold;
 * this is the only carrier of the now-unsealed `value` (structural, see core). */
export interface PlayerSale {
  /** Current owner (post-trade). */
  ownerSlot: number | null;
  ownerShort: string | null;
  /** Salary paid (travels with the player through trades). */
  price: number;
  lotNo: number | null;
  /** Now-unsealed Claude value (revealed at the hammer). */
  value: number | null;
  delta: number | null;
  verdict: Verdict | null;
}

/** One past season on the player page (#60/#61), joined by the stable FPL code.
 * A numeric field is null when that category did not exist that season (N/A,
 * e.g. expected_* before 2022-23, defContribution before 2025-26). A season the
 * player was absent for is returned as { season, notInFpl: true } with the rest
 * null. `xg`..`ictIndex` are the advanced/expected metrics surfaced by #60. */
export interface PlayerSeason {
  season: string;
  /** True when the player was not in FPL that season (distinct from N/A nulls). */
  notInFpl: boolean;
  position: Position | null;
  totalPoints: number | null;
  minutes: number | null;
  starts: number | null;
  goals: number | null;
  assists: number | null;
  cleanSheets: number | null;
  goalsConceded: number | null;
  saves: number | null;
  pensSaved: number | null;
  pensMissed: number | null;
  bonus: number | null;
  yellows: number | null;
  reds: number | null;
  ownGoals: number | null;
  defContribution: number | null;
  xg: number | null;
  xa: number | null;
  xgi: number | null;
  xgc: number | null;
  influence: number | null;
  creativity: number | null;
  threat: number | null;
  ictIndex: number | null;
}

export interface PlayerDetailPayload {
  version: number;
  player: PlayerDetail;
  /** Null unless the player is sold (#51: full spotlight + sale result). */
  sale: PlayerSale | null;
  /** Up to five past seasons, chronological (#60/#61). Empty if not ingested. */
  history: PlayerSeason[];
  generatedAt: string;
}

/** Assemble the /api/player/[id] payload, or null if the id is unknown. */
export async function getPlayerDetailPayload(
  playerId: number,
): Promise<PlayerDetailPayload | null> {
  return (await buildPlayerDetailPayloadCore(
    sql,
    getConfig(),
    playerId,
  )) as PlayerDetailPayload | null;
}
