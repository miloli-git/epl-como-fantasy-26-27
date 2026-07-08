// DELETE /api/draft/latest - undo the most recent sale (02-SPEC §E "Undo
// last sale"). Commissioner-gated; runs inside the serialising auction lock
// (lib/corrections-core.mjs), writes a 'sale.void' audit row and puts the
// undone player back on the block.
//
// Optional JSON body {expectedSaleId}: when present, the undo only proceeds
// if the newest sale still has that id - a double-submitted undo then
// removes one sale, not two (the second call gets a 'stale_undo' 422). No
// body keeps the old unconditional behaviour.

import { NextResponse } from "next/server";
import { requireCommissioner } from "@/lib/auth";
import { undoLastSale } from "@/lib/corrections";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function DELETE(request: Request) {
  try {
    if (!requireCommissioner(request)) {
      return NextResponse.json(
        { error: "commissioner token required" },
        { status: 401, headers: NO_STORE },
      );
    }

    // Optional body {expectedSaleId} - absent (or no body at all) keeps the
    // unconditional undo for API compatibility.
    let expectedSaleId: unknown;
    try {
      const body = (await request.json()) as Record<string, unknown> | null;
      expectedSaleId = body?.expectedSaleId;
    } catch {
      expectedSaleId = undefined;
    }
    if (expectedSaleId !== undefined && !Number.isInteger(expectedSaleId)) {
      return NextResponse.json(
        { error: "expectedSaleId, when present, must be a whole number" },
        { status: 400, headers: NO_STORE },
      );
    }

    const result = await undoLastSale({
      actor: "commissioner",
      expectedSaleId: expectedSaleId as number | undefined,
    });

    if (!result.ok) {
      // A structured rejection, not an error: the console shows result.message.
      const status = result.code === "not_found" ? 404 : 422;
      return NextResponse.json(result, { status, headers: NO_STORE });
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    // Log the real error server-side; never leak it to clients.
    console.error("DELETE /api/draft/latest failed:", err);
    return NextResponse.json(
      { error: "undo failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
