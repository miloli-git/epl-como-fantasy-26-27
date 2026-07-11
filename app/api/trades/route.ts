// GET /api/trades - the read-only trades log (#58). Every non-voided trade,
// newest first, with cash and the players that moved each way. No player
// value ever appears here (see lib/trades-core.mjs). Open read, no auth
// (war-room model). Never cached: it must reflect the latest trade.

import { NextResponse } from "next/server";
import { getTradesPayload } from "@/lib/trades";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await getTradesPayload();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("GET /api/trades failed:", err);
    return NextResponse.json(
      { error: "trades unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
