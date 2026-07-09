// GET /api/player/:id - the single-player read-only spotlight behind a ledger
// click (#51). Open read, no auth (war-room model: no private data leaves
// here; the sealed valuation for an unsold player is excluded STRUCTURALLY in
// lib/player-detail-core.mjs - the base player query never joins valuations,
// and `value` only ever rides on the `sale` object, which is null unless the
// player is sold). Never cached: it must reflect the latest recorded sale.

import { NextResponse } from "next/server";
import { getPlayerDetailPayload } from "@/lib/player-detail";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type RouteContext = { params: Promise<{ id: string }> };

/** Parse the :id segment as a positive integer player id, or null. */
async function playerIdFrom(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  if (!/^\d+$/.test(id)) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const playerId = await playerIdFrom(context);
    if (playerId == null) {
      return NextResponse.json(
        { error: "player id must be a positive integer" },
        { status: 400, headers: NO_STORE },
      );
    }
    const payload = await getPlayerDetailPayload(playerId);
    if (payload == null) {
      return NextResponse.json(
        { error: "player not found" },
        { status: 404, headers: NO_STORE },
      );
    }
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (err) {
    // Log the real error server-side; never leak it to clients.
    console.error("GET /api/player/[id] failed:", err);
    return NextResponse.json(
      { error: "player unavailable" },
      { status: 500, headers: NO_STORE },
    );
  }
}
