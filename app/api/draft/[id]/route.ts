// PATCH  /api/draft/:id - edit any sale (manager and/or price + reason).
// DELETE /api/draft/:id - void any sale (reason required).
// Commissioner-gated corrections (02-SPEC §F: edit/void any sale with audit).
// Both run inside the serialising auction lock via lib/corrections.
//
// DELETE reason transport: the JSON body {reason} is the primary channel
// (Next 15 route handlers parse DELETE bodies fine via request.json()); a
// ?reason= query param is accepted as a fallback for clients that cannot
// send a DELETE body.

import { NextResponse } from "next/server";
import { requireCommissioner } from "@/lib/auth";
import { editSale, voidSale } from "@/lib/corrections";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type RouteContext = { params: Promise<{ id: string }> };

/** Parse the :id segment as a positive integer sale id, or null. */
async function saleIdFrom(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  if (!/^\d+$/.test(id)) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function rejectionResponse(result: { ok: false; code: string; message: string }) {
  const status = result.code === "not_found" ? 404 : 422;
  return NextResponse.json(result, { status, headers: NO_STORE });
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    if (!requireCommissioner(request)) {
      return NextResponse.json(
        { error: "commissioner token required" },
        { status: 401, headers: NO_STORE },
      );
    }

    const saleId = await saleIdFrom(context);
    if (saleId == null) {
      return NextResponse.json(
        { error: "sale id must be a positive whole number" },
        { status: 400, headers: NO_STORE },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "body must be JSON: {managerId?, price?, reason}" },
        { status: 400, headers: NO_STORE },
      );
    }
    // Reject unexpected keys loudly: a client trying to change a field this
    // route does not support must get a clear 400, not a silent partial edit.
    const ALLOWED_KEYS = new Set(["playerId", "managerId", "price", "reason"]);
    const unexpectedKey = Object.keys((body ?? {}) as Record<string, unknown>).find(
      (key) => !ALLOWED_KEYS.has(key),
    );
    if (unexpectedKey !== undefined) {
      return NextResponse.json(
        { error: `unexpected key "${unexpectedKey}" - allowed keys: playerId, managerId, price, reason` },
        { status: 400, headers: NO_STORE },
      );
    }
    const { playerId, managerId, price, reason } = (body ?? {}) as Record<string, unknown>;
    if (playerId !== undefined && !Number.isInteger(playerId)) {
      return NextResponse.json(
        { error: "playerId, when present, must be a whole number" },
        { status: 400, headers: NO_STORE },
      );
    }
    if (managerId !== undefined && !Number.isInteger(managerId)) {
      return NextResponse.json(
        { error: "managerId, when present, must be a whole number" },
        { status: 400, headers: NO_STORE },
      );
    }
    if (price !== undefined && !Number.isInteger(price)) {
      return NextResponse.json(
        { error: "price, when present, must be a whole number" },
        { status: 400, headers: NO_STORE },
      );
    }
    if (reason !== undefined && typeof reason !== "string") {
      return NextResponse.json(
        { error: "reason must be a string" },
        { status: 400, headers: NO_STORE },
      );
    }

    const result = await editSale({
      saleId,
      playerId: playerId as number | undefined,
      managerId: managerId as number | undefined,
      price: price as number | undefined,
      reason: (reason as string | undefined) ?? "",
      actor: "commissioner",
    });

    if (!result.ok) return rejectionResponse(result);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    console.error("PATCH /api/draft/[id] failed:", err);
    return NextResponse.json(
      { error: "edit failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    if (!requireCommissioner(request)) {
      return NextResponse.json(
        { error: "commissioner token required" },
        { status: 401, headers: NO_STORE },
      );
    }

    const saleId = await saleIdFrom(context);
    if (saleId == null) {
      return NextResponse.json(
        { error: "sale id must be a positive whole number" },
        { status: 400, headers: NO_STORE },
      );
    }

    // Primary: JSON body {reason}. Fallback: ?reason= query param (for
    // clients that cannot attach a DELETE body). Absent/empty reason is a
    // structured 422 from the core.
    let reason: unknown;
    try {
      const body = (await request.json()) as Record<string, unknown> | null;
      reason = body?.reason;
    } catch {
      reason = undefined;
    }
    if (reason === undefined) {
      reason = new URL(request.url).searchParams.get("reason") ?? undefined;
    }
    if (reason !== undefined && typeof reason !== "string") {
      return NextResponse.json(
        { error: "reason must be a string" },
        { status: 400, headers: NO_STORE },
      );
    }

    const result = await voidSale({
      saleId,
      reason: (reason as string | undefined) ?? "",
      actor: "commissioner",
    });

    if (!result.ok) return rejectionResponse(result);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    console.error("DELETE /api/draft/[id] failed:", err);
    return NextResponse.json(
      { error: "void failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
