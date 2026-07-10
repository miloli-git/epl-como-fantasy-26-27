// GET /api/recap - the post-auction recap + awards read. Per-manager leftover
// money (Y1, from the durable snapshot when present, else derived live) plus
// awards derived from the ledger (biggest overpay, steal of the night, fastest
// hammer). Open read, no auth (war-room model). Sealed valuations are never
// widened here: the awards read `value` only from already-sold rows, reusing
// the structurally-sealed players assembly (see lib/recap-core.mjs). Never
// cached: it must reflect the latest sale/trade and the latest archive.

import { NextResponse } from "next/server";
import { getRecapPayload } from "@/lib/recap";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await getRecapPayload();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("GET /api/recap failed:", err);
    return NextResponse.json(
      { error: "recap unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
