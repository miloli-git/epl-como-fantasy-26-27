// Typed wrapper: binds the pure recap assembly (lib/recap-core.mjs) to the
// app's shared postgres pool and league config. The /api/recap route is a thin
// wrapper over this; scripts/test-recap.mjs drives recap-core directly with its
// own client so the exact same assembly is what gets tested.

import { getConfig } from "./config";
import { sql } from "./db";
import { buildRecapPayload as buildRecapPayloadCore } from "./recap-core.mjs";

/** One award: a sold player and how it earned the award. */
export interface RecapAward {
  playerId: number;
  name: string | null;
  ownerSlot: number | null;
  ownerShort: string | null;
  price: number | null;
  value: number | null;
  delta: number | null;
  /** Seconds on the block before the hammer (fastestHammer only). */
  seconds?: number;
}

/** Per-manager leftover money (Y1) - the February war chest. */
export interface RecapManager {
  slot: number;
  short: string;
  spent: number;
  leftover: number;
  squadCount: number;
}

export interface RecapPayload {
  /** Season id from league.config.json. */
  season: string;
  /** True when a durable season_recap snapshot exists (numbers of record). */
  archived: boolean;
  /** ISO time of the latest snapshot row, or null when not yet archived. */
  archivedAt: string | null;
  version: number;
  soldCount: number;
  /** How many sold players carry a sealed value (awards degrade below this). */
  valuedCount: number;
  totalSpent: number;
  totalLeftover: number;
  /** Sorted by slot. */
  managers: RecapManager[];
  awards: {
    biggestOverpay: RecapAward | null;
    steal: RecapAward | null;
    fastestHammer: RecapAward | null;
  };
  generatedAt: string;
}

/** Assemble the full /api/recap payload against the app's pool + config. */
export async function getRecapPayload(): Promise<RecapPayload> {
  return (await buildRecapPayloadCore(sql, getConfig())) as RecapPayload;
}
