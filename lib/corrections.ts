// Typed wrapper: binds the pure correction transactions
// (lib/corrections-core.mjs) to the app's shared postgres pool and league
// config. The /api/draft/latest and /api/draft/[id] routes are thin wrappers
// over this; scripts/test-corrections.mjs drives corrections-core directly
// with its own client so the exact same transactions are what get tested.

import { getConfig } from "./config";
import {
  editSale as editSaleCore,
  undoLastSale as undoLastSaleCore,
  voidSale as voidSaleCore,
} from "./corrections-core.mjs";
import { sql } from "./db";

export interface CorrectionRejection {
  ok: false;
  /** Machine-readable rule name, e.g. "not_found", "over_max_bid". */
  code: string;
  /** Plain-English rule + number, safe to show on the console. */
  message: string;
}

/** A sale row as it stood (audit payload shape). */
export interface SaleSnapshot {
  id: number;
  player_id: number;
  manager_id: number;
  price: number;
  lot_no: number | null;
  phase: number | null;
  created_at: string;
}

export type UndoResult = { ok: true; undone: SaleSnapshot } | CorrectionRejection;
export type EditResult =
  | { ok: true; sale: SaleSnapshot; before: SaleSnapshot }
  | CorrectionRejection;
export type VoidResult = { ok: true; voided: SaleSnapshot } | CorrectionRejection;

/** Undo the most recent sale and put the player back on the block. */
export async function undoLastSale(args: { actor: string }): Promise<UndoResult> {
  return (await undoLastSaleCore(sql, getConfig(), args)) as UndoResult;
}

/** Edit any sale (manager and/or price), re-validating full legality. */
export async function editSale(args: {
  saleId: number;
  managerId?: number;
  price?: number;
  reason: string;
  actor: string;
}): Promise<EditResult> {
  return (await editSaleCore(sql, getConfig(), args)) as EditResult;
}

/** Void any sale (the player becomes available again). */
export async function voidSale(args: {
  saleId: number;
  reason: string;
  actor: string;
}): Promise<VoidResult> {
  return (await voidSaleCore(sql, getConfig(), args)) as VoidResult;
}
