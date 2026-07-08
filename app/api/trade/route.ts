// POST /api/trade - record a two-sided trade (players and/or cash between two
// managers). Commissioner-gated; all guardrails (ownership, no negative
// budget, quotas, squad <= 15) are enforced server-side inside a serialising
// transaction (lib/trade-core.mjs). Salaries travel with players; cash settles
// the difference; both managers' budgets and max bids recompute on the board.

import { NextResponse } from "next/server";
import { requireCommissioner } from "@/lib/auth";
import { recordTrade } from "@/lib/trade";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    if (!requireCommissioner(request)) {
      return NextResponse.json(
        { error: "commissioner token required" },
        { status: 401, headers: NO_STORE },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          error:
            "body must be JSON: {managerA, managerB, playersAToB?, playersBToA?, cashAToB?, cashBToA?, reason?}",
        },
        { status: 400, headers: NO_STORE },
      );
    }
    const { managerA, managerB, playersAToB, playersBToA, cashAToB, cashBToA, reason } =
      (body ?? {}) as Record<string, unknown>;

    if (!Number.isInteger(managerA) || !Number.isInteger(managerB)) {
      return NextResponse.json(
        { error: "managerA and managerB must be whole numbers" },
        { status: 400, headers: NO_STORE },
      );
    }

    const result = await recordTrade({
      managerA: managerA as number,
      managerB: managerB as number,
      playersAToB: playersAToB as number[] | undefined,
      playersBToA: playersBToA as number[] | undefined,
      cashAToB: cashAToB as number | undefined,
      cashBToA: cashBToA as number | undefined,
      reason: reason as string | undefined,
      actor: "commissioner",
    });

    if (!result.ok) {
      // A rule rejection, not an error: the console shows result.message.
      return NextResponse.json(result, { status: 422, headers: NO_STORE });
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    console.error("POST /api/trade failed:", err);
    return NextResponse.json(
      { error: "trade failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
